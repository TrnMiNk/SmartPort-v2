# Evidence: TDE verification for NFR-SEC-06 (2026-11-19)

Assessment and runbook: `docs/architecture/encryption-at-rest.md`. Tool: `API/scripts/tde-verify.js` (one process; random passwords exist only in memory; nothing secret is printed or stored). Instance: SQL Server 2022 16.0.1000.6 **Developer** Edition, sysadmin login. Test database: `SmartPortV2_LoadTde` (new), restored copy `SmartPortV2_LoadTdeRestored` (new). **No existing database was encrypted, changed or restored over** (`SmartPortV2_DemoFinal`, the verification and legacy databases were not touched; a read-only check of `DemoFinal` afterwards is in section 6).

## 1. Method
The script refuses an instance that already has a database master key in `master`, a user certificate or an encrypted database, so it cannot disturb a real TDE set-up (before the run: none). It created the database, ran migrations 0001 to 0008 and the catalog seed, inserted a marker text with random value, then:
1. **Before encryption (control):** the 50-user load test (30 s steady + 15 s stress), a full backup, and a byte search of the backup file for the marker (nvarchar is UTF-16LE; both encodings searched).
2. Created a database master key and a certificate in `master`, backed up the certificate with its private key to files (encrypted by a random password), created the database encryption key (AES-256) and turned encryption on.
3. **After encryption:** authorized read, the integration test suite, the load test again, a new backup and the same byte search.
4. **Restore proofs:** restore under a new name (certificate present); drop both databases and the certificate; restore again (certificate absent); re-create the certificate from the backup files; restore again.
5. **Clean-up:** dropped both databases, the certificate and the master key it created, deleted its files.

## 2. Results
| Check | Result |
|---|---|
| Control: marker in the **plaintext** backup | found (UTF-16LE), so the search method works |
| Encryption | `encryption_state = 3` (encrypted), AES, 256 bits, protected by certificate, `sys.databases.is_encrypted = 1`; the 8 MB database took about 1 s |
| Marker in the **encrypted** backup | **absent** (both encodings) |
| Authorized access | marker row read back through a normal login; also after the database was taken offline and online |
| Application compatibility | 16 integration files (192 tests; the 3 migration tests excluded because they use a separate scratch database): **192 passed, 0 failed**, no code or SQL change |
| Restore with the certificate present | worked; the copy is encrypted and the marker row is readable |
| Restore after the certificate was dropped | **refused** (`RESTORE DATABASE is terminating abnormally`, error 3013; SQL Server needs the certificate to read the backup) |
| Certificate re-created from the backed-up `.cer` + `.pvk` + password | restore worked; marker readable |
| Master key and certificate after clean-up | removed (`master` has no database master key and no user certificate; verified by query) |
| Data file | not inspected: SQL Server restricts its data file to its service account, so the backup file is the inspected copy |

## 3. Performance and compatibility (same machine, same script, 50 users, one API process)
| | Plaintext | TDE |
|---|---|---|
| Sign-in, 50 at once (max) | 277 ms | 328 ms |
| Steady: requests, req/s, p50 / p95 / p99 / max, failed | 1521, 48.6, 7.8 / 38.5 / 99.8 / 192 ms, 0 | 1532, 48.8, 8.0 / 33.9 / 92.7 / 198 ms, 0 |
| Stress: requests, req/s, p50 / p95 / p99 / max, failed | 9004, 597, 83 / 106 / 127 / 262 ms, 0 | 8636, 574, 87 / 110 / 132 / 228 ms, 0 |
| Consistency checks | 9 of 9 | 9 of 9 |
| Backup of the test database | 69 ms, 8.3 MB | 87 ms, 12.6 MB (the larger size was not investigated) |
Three earlier plaintext runs of the same load gave 575 to 599 req/s in the stress phase and 277 to 349 ms for sign-in, so the differences above are inside the run-to-run noise. **Limit:** the database is a few MB and fits in memory, so this measures the CPU path of encrypted page writes only; disk-bound workloads and large databases were not measured.

## 4. Side effects on the verified instance (cannot be avoided with TDE)
The first encrypted database made SQL Server **encrypt tempdb** for the whole instance; tempdb stays encrypted (`encryption_state = 3`, visible now) until the SQL Server service is restarted. I did not restart the service. The certificate that protected it was dropped; tempdb is recreated at restart. This is a small CPU cost for every database on that instance until then.
A throw-away folder `C:\SPTdeVerify_233b0f` remains with `SPTdeVerifyCert.cer` and `SPTdeVerifyCert.pvk` (created by the SQL Server service account; I could not delete them without administrator rights). The private key file is protected by a random password that was discarded, and the certificate is gone from `master`, so the files are useless; delete the folder as administrator. Earlier failed attempts of the script (fixed) left no database, key, certificate or file behind (verified by query).
Because the script's default behaviour needs sysadmin and changes instance-level objects, it must never be pointed at a production instance.

## 5. Conclusion for B6-3
Feasible and verified: TDE protects 100% of stored data (files, log, tempdb, backups) with no application change, no measurable impact on this workload, and a restore that needs the certificate (proved both ways). **B6-3 is not closed**: it closes when the owner accepts ENC-1, the production edition is confirmed to include TDE, TDE is enabled on the target database(s), and the certificate custody and restore test are in place (`encryption-at-rest.md` section 6). `SmartPortV2_DemoFinal` is still unencrypted by design (it must be preserved).

## 6. Read-only check of the preserved demo database (after all tests)
`SmartPortV2_DemoFinal`: schema readiness OK (migrations 0001 to 0008, checksums match); 24 voyages (3 BERTH_ASSIGNED, 2 BERTHED, 2 DEPARTED, 1 MISSING_DOCUMENTS, 16 WAITING_BERTH); plans: 5 APPROVED, 2 COMPLETED, 3 PENDING_APPROVAL, 1 REJECTED, all `MANUAL`; 8 active berths; `check-consistency` 9 of 9; six demo accounts with the expected roles (`demo_dieuphoi`, `demo_dieuphoi2` coordinator; `demo_quanly`, `demo_quanly2` manager; `demo_khobai` yard; `demo_daily` agent), all active; `is_encrypted = 0`. Only SELECT statements were run.

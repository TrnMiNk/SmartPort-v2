# NFR-SEC-06: encryption at rest. Assessment and runbook (2026-11-19)

Status: **assessment and verification only**. No existing database was encrypted or changed. The recommended option was verified on a new disposable database (`docs/testing/tde-evidence.md`). Enabling it on a target database is a deployment decision (section 6).

## 1. The requirement
NFR-SEC-06 (SRS 3.3): "Encrypt sensitive data (cargo, ship, invoice and account information) when stored; role-based access to data" with the criterion "100% of sensitive fields encrypted". Role-based access is already enforced and tested (NFR-SEC-02).
What is sensitive in this system (stored in SQL Server): cargo information (voyage `cargo_type`, TEU, hazard basis, notice data), ships (name, IMO, dimensions, document metadata), accounts (`auth_users`: login name, display name, roles; passwords are already stored only as scrypt hashes and session tokens only as SHA-256 hashes, so they are protected differently and need no encryption), berth plans, audit and notification text. Invoices belong to Module 5, which is not built.
The SRS gives no field list. Assumption **ENC-1** (needs the owner): *every table of the database is in scope*, because that is the only reading under which "100% of sensitive fields" can be shown without a field catalogue. Encrypting the whole database at rest satisfies it for data files, transaction logs, tempdb and backups at once.

## 2. Options
| | TDE (Transparent Data Encryption) | Always Encrypted | Application-level encryption |
|---|---|---|---|
| Where | SQL Server encrypts pages as they are written to data and log files, tempdb and backups (AES-256 here) | The client driver encrypts chosen columns; the server only ever sees ciphertext | The Node code encrypts chosen fields (for example AES-GCM) before sending them |
| Satisfies NFR-SEC-06 | **Yes, for 100% of stored data (ENC-1)**, no field catalogue needed | Only for the columns chosen; "100%" would need every sensitive column to be listed and changed | Same as Always Encrypted |
| Protects against | Theft or loss of disks, files, snapshots and **backups**; restoring a backup on an unauthorized server | The above **and** a DBA or a compromised database server reading the columns | The above and any database-level reader |
| Does not protect against | Anyone who may query the database (authorized users, DBAs), SQL injection, a compromised application: data is decrypted for them | Application compromise; metadata, row counts and access patterns remain visible | Same; plus keys live in the application |
| Application change | **None** (verified: 192 integration tests and the load test ran unchanged) | Large: ODBC driver 18 column encryption, typed parameters in every repository, key store; equality only on deterministic columns, **no LIKE, range or ORDER BY** on ciphertext (search by IMO or name, sorting, the schedule filters would break); `msnodesqlv8` support unverified | Large: every repository and migration touched; search, sort and uniqueness (IMO) on those fields lost or reimplemented; key rotation work |
| Performance | Small CPU cost for page encryption; none measured here (section 5 of the evidence) | Higher: client-side work, limited server-side query features | Client-side work; extra reads |
| Key management | Certificate in `master` (protected by the database master key); **the certificate and its private key must be backed up outside the instance**; without them backups and files cannot be restored (verified) | Column master key in a Windows certificate store, Azure Key Vault or HSM; column encryption keys in the database | Key in a secret store or KMS; rotation is the application's job |
**Recommendation: TDE for the production database(s)**, with transport encryption (TLS to the web tier and `encrypt=true` to SQL Server, already the default) and the existing role-based access. Always Encrypted or field encryption are not needed to meet the wording of NFR-SEC-06 and would break search and sorting; consider them only if the owner adds a requirement that even DBAs must not read specific fields (a different, stronger requirement).

## 3. Licensing and prerequisites (verify against Microsoft's current documentation for your exact version and edition before purchase)
TDE is available in SQL Server Enterprise and Developer, and in Standard from SQL Server 2019; it is not available in Express. The verified instance is SQL Server 2022 (16.0.1000.6) Developer, which is not licensed for production use. A production host needs an edition that includes TDE. Requires: `sysadmin` (or equivalent) to create the master key and certificate; a secret store for the master key and certificate-backup passwords; a secure location for certificate backups (separate from database backups).

## 4. What enabling it involves (not executed against any existing database)
1. In `master`: `CREATE MASTER KEY ENCRYPTION BY PASSWORD = '<from the secret store>'`; `CREATE CERTIFICATE <name> WITH SUBJECT = '<purpose, owner>'`.
2. **Immediately** `BACKUP CERTIFICATE <name> TO FILE = '<path>.cer' WITH PRIVATE KEY (FILE = '<path>.pvk', ENCRYPTION BY PASSWORD = '<from the secret store>')`; copy both files and the password to the approved off-instance store; test a restore.
3. In the target database: `CREATE DATABASE ENCRYPTION KEY WITH ALGORITHM = AES_256 ENCRYPTION BY SERVER CERTIFICATE <name>`; `ALTER DATABASE [<db>] SET ENCRYPTION ON`; watch `sys.dm_database_encryption_keys` until `encryption_state = 3`.
4. Backups taken afterwards are encrypted automatically. A restore on another instance needs the certificate first (`CREATE CERTIFICATE ... FROM FILE ... WITH PRIVATE KEY (... DECRYPTION BY PASSWORD ...)`).
5. Side effects: **tempdb is encrypted for the whole instance** as soon as the first database is encrypted, and stays so until the instance restarts; compressed backups need `MAXTRANSFERSIZE` above 65536 to compress; rotate the certificate on a schedule (TDE does not check certificate expiry, so an expired certificate does not stop the database, but rotation is still good practice).
6. Rollback: `ALTER DATABASE ... SET ENCRYPTION OFF`, wait for state 1, `DROP DATABASE ENCRYPTION KEY`; keep the certificate until every backup that used it is retired.
The application needs no change and no migration; `scripts/tde-verify.js` automates steps 1 to 6 on a new disposable database only (it refuses an instance that already uses TDE or has a master key).

## 5. Risks that remain after TDE
Authorized users and DBAs still see plaintext. Loss of the certificate or its password makes databases and backups permanently unreadable. Key custody, rotation and access to the certificate backups need an owner and a written procedure. TDE protects data at rest only; TLS, the cookie settings and the web-host headers are separate (see `docs/testing/b2-b6-evidence.md`).

## 6. Decisions needed
(1) Accept assumption ENC-1 or provide the list of sensitive fields. (2) Choose TDE (recommended) or ask for field-level protection. (3) Confirm the production SQL Server edition includes TDE. (4) Name the owner of the certificate and password custody and of the restore test. Until the chosen option is enabled on the target databases, NFR-SEC-06 is **not satisfied in the deployed system**, although the solution is verified.

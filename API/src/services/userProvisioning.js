'use strict';

// Creates a user with a hashed password and role assignments in one transaction. Used by the seed script and by
// tests. Unknown role codes fail the whole operation (default deny).

const { hashPassword } = require('../security/password');

async function createUser(db, { username, displayName, password, roleCodes, agentId = null }) {
  if (!password || password.length < 12) {
    throw new Error('password must be at least 12 characters');
  }
  const tx = new db.sql.Transaction(db.pool);
  await tx.begin();
  try {
    const req = new db.sql.Request(tx);
    const inserted = await req
      .input('username', db.sql.NVarChar(100), username)
      .input('displayName', db.sql.NVarChar(200), displayName)
      .input('passwordHash', db.sql.VarChar(255), hashPassword(password))
      .query(`INSERT INTO dbo.auth_users (username, display_name, password_hash)
              VALUES (@username, @displayName, @passwordHash); SELECT SCOPE_IDENTITY() AS id;`);
    const userId = inserted.recordset[0].id;

    for (const code of roleCodes) {
      const role = await new db.sql.Request(tx)
        .input('code', db.sql.VarChar(40), code)
        .query('SELECT role_id FROM dbo.auth_roles WHERE role_code = @code');
      if (role.recordset.length === 0) throw new Error(`unknown role: ${code}`);
      await new db.sql.Request(tx)
        .input('userId', db.sql.BigInt, userId)
        .input('roleId', db.sql.Int, role.recordset[0].role_id)
        .query('INSERT INTO dbo.auth_user_roles (user_id, role_id) VALUES (@userId, @roleId)');
    }

    if (agentId != null) {
      await new db.sql.Request(tx)
        .input('userId', db.sql.BigInt, userId)
        .input('agentId', db.sql.Int, agentId)
        .query('INSERT INTO dbo.auth_user_agents (user_id, agent_id) VALUES (@userId, @agentId)');
    }

    await tx.commit();
    return { userId };
  } catch (err) {
    await tx.rollback();
    throw err;
  }
}

module.exports = { createUser };

defmodule Grappa.Repo.Migrations.AllowNullPasswordHashOnUsers do
  @moduledoc """
  #1911c — `users.password_hash` becomes nullable: an OIDC-provisioned
  account's only credential is the provider's `sub`, so
  `Accounts.provision_user/1` inserts a row with NO hash
  (`User.provisioned_changeset/2` leaves the field `nil`, and
  `Accounts.verify_password/2` answers `{:error, :invalid_credentials}`
  on a nil hash instead of crashing Argon2).

  SQLite cannot drop a NOT NULL in place, so this is the documented
  table-recreate dance — with ONE deviation from the house precedent
  (`XorFkUserSettings`): `users` is the parent of ten ON DELETE CASCADE
  foreign keys, and ecto_sqlite3 runs DDL inside a transaction where
  `PRAGMA foreign_keys` is a no-op (it silently stays `:on`). Two
  consequences, both measured against that constraint:

    * RENAME first (the precedent's order) would, with FKs ON and
      `legacy_alter_table` at its modern default, REWRITE every child's
      REFERENCES clause to point at the renamed table — poisoning the
      schema the moment the rename lands. `PRAGMA legacy_alter_table=ON`
      (connection state, NOT transaction-scoped, so it works mid-
      migration) restores the old no-rewrite rename semantics; it is
      turned back OFF before the migration returns.
    * The copy runs BEFORE the old table is dropped, so the implicit
      `DELETE FROM` of `DROP TABLE` finds no referencing child row —
      every child still points at `users`, which by then carries the
      full copied row set. `PRAGMA foreign_key_check` at the end asserts
      it; a violation fails the migration loudly rather than shipping a
      silently corrupted DB.

  Column set and shapes are the ones the four `users` migrations to date
  built (`CreateUsers`, `AddIsAdminToUsers`, `AddUserTotp`,
  `AddUserPasskeys`); only the NULL constraint on `password_hash`
  changes. `down/0` refuses while any passwordless row exists — the
  NOT NULL restore cannot represent them, and failing loudly beats
  silently deleting accounts.
  """

  use Ecto.Migration

  @users_columns ~w(id name password_hash inserted_at updated_at is_admin
                    totp_secret_encrypted totp_enabled_at totp_last_used_step
                    passkey_mode)

  def up do
    execute("PRAGMA legacy_alter_table=ON")

    execute("ALTER TABLE users RENAME TO users_old")

    execute("""
    CREATE TABLE "users" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "name" TEXT NOT NULL,
      "password_hash" TEXT,
      "inserted_at" TEXT NOT NULL,
      "updated_at" TEXT NOT NULL,
      "is_admin" BOOLEAN NOT NULL DEFAULT false,
      "totp_secret_encrypted" BLOB,
      "totp_enabled_at" TEXT,
      "totp_last_used_step" INTEGER,
      "passkey_mode" TEXT NOT NULL DEFAULT 'disabled'
    )
    """)

    execute("""
    INSERT INTO users (#{Enum.join(@users_columns, ", ")})
    SELECT #{Enum.join(@users_columns, ", ")} FROM users_old
    """)

    execute("DROP TABLE users_old")

    create unique_index(:users, [:name])

    execute("PRAGMA legacy_alter_table=OFF")

    %{rows: rows} = repo().query!("PRAGMA foreign_key_check")
    if rows != [], do: raise("users rebuild left foreign key violations")
  end

  def down do
    %{rows: [[n]]} =
      repo().query!("SELECT COUNT(*) FROM users WHERE password_hash IS NULL")

    if n > 0,
      do: raise("cannot restore NOT NULL: #{n} passwordless users exist")

    execute("PRAGMA legacy_alter_table=ON")

    execute("ALTER TABLE users RENAME TO users_old")

    execute("""
    CREATE TABLE "users" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "name" TEXT NOT NULL,
      "password_hash" TEXT NOT NULL,
      "inserted_at" TEXT NOT NULL,
      "updated_at" TEXT NOT NULL,
      "is_admin" BOOLEAN NOT NULL DEFAULT false,
      "totp_secret_encrypted" BLOB,
      "totp_enabled_at" TEXT,
      "totp_last_used_step" INTEGER,
      "passkey_mode" TEXT NOT NULL DEFAULT 'disabled'
    )
    """)

    execute("""
    INSERT INTO users (#{Enum.join(@users_columns, ", ")})
    SELECT #{Enum.join(@users_columns, ", ")} FROM users_old
    """)

    execute("DROP TABLE users_old")

    create unique_index(:users, [:name])

    execute("PRAGMA legacy_alter_table=OFF")
  end
end

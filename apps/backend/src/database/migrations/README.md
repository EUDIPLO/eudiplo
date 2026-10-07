# TypeORM Migrations

This directory contains TypeORM database migrations for the EUDIPLO backend.

## Migration Commands

Run these commands from the `apps/backend` directory:

```bash
# Create an empty migration (write it by hand: it must work on SQLite and PostgreSQL)
pnpm migration:create src/database/migrations/MigrationName

# Run pending migrations
pnpm migration:run

# Revert the last migration
pnpm migration:revert

# Show migration status
pnpm migration:show
```

## Important Notes

1. **Production Safety**: The `synchronize` option is now disabled by default. Use migrations for schema changes in production.

2. **For Existing Databases**: If you're upgrading from a version that used `synchronize: true`, the baseline migration leaves the existing schema and data untouched. Later migrations apply the required incremental changes.

3. **For New Installations**: The baseline migration creates the complete schema automatically. Keep `DB_SYNCHRONIZE=false` and `DB_MIGRATIONS_RUN=true`; no two-step startup is required.

4. **Development Mode**: You can enable `DB_SYNCHRONIZE=true` for development to auto-sync schema changes, but this is not recommended for production.

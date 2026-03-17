# Database (Prisma)

PostgreSQL via [Neon](https://neon.tech), managed with Prisma ORM.

## Setup

1. Copy `.env.example` to `.env` and set `DATABASE_URL`.
2. Run `pnpm run db:migrate` to apply all migrations locally.

## How migrations work

- Migration files live in `prisma/migrations/` and are committed to git.
- The **build script** (`prisma migrate deploy`) auto-applies pending migrations on every deploy — no manual DB commands needed in production.
- `prisma migrate deploy` is safe: it only applies unapplied migrations and will fail rather than drop data.

## Modifying the schema

1. Edit `prisma/schema.prisma`.
2. Generate a migration:
   ```bash
   pnpm run db:migrate -- --name describe-the-change
   ```
   This creates a SQL file in `prisma/migrations/` and applies it to your local DB.
3. Commit the migration file and schema changes.
4. Deploy — migrations are applied automatically during build.

## Available scripts

| Script | Command | Description |
|--------|---------|-------------|
| `db:migrate` | `prisma migrate dev` | Create & apply a new migration (local dev) |
| `db:migrate:deploy` | `prisma migrate deploy` | Apply pending migrations (production) |
| `db:migrate:reset` | `prisma migrate reset` | Drop & recreate DB (destroys all data) |
| `db:push` | `prisma db push` | Sync schema without migrations (prototyping only) |
| `db:pull` | `prisma db    pull` | Pull schema from existing DB |
| `db:generate` | `prisma generate` | Regenerate Prisma Client |
| `db:studio` | `prisma studio` | Open Prisma Studio GUI |
| `db:validate` | `prisma validate` | Validate schema file |

## Rules

- **Never** use `db:push` in production — it can silently drop columns/data.
- **Never** use `db:migrate:reset` on production — it wipes everything.
- Always create migrations locally with `db:migrate`, commit the SQL files, and let the deploy pipeline handle the rest.

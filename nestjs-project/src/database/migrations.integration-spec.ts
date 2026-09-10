import { DataSource } from 'typeorm';
import { User } from '../users/entities/user.entity';
import { Channel } from '../channels/entities/channel.entity';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Video } from '../videos/entities/video.entity';
import { CreateUsersAndChannels1775687773260 } from './migrations/1775687773260-CreateUsersAndChannels';
import { CreateAuthTokens1777579850478 } from './migrations/1777579850478-CreateAuthTokens';
import { CreateVideos1788919095269 } from './migrations/1788919095269-CreateVideos';
import { createTestDataSource } from '../test/create-test-data-source';

const ALL_MIGRATIONS = [
  CreateUsersAndChannels1775687773260,
  CreateAuthTokens1777579850478,
  CreateVideos1788919095269,
];

// Every schema object owned by the migrations above. Both lists must be kept in
// sync whenever a migration is added: this suite wipes the schema before
// running them, and any leftover object makes the next run fail (a surviving
// table breaks with "already exists", a surviving enum type with
// "type already exists").
const MANAGED_TABLES = [
  'videos',
  'refresh_tokens',
  'verification_tokens',
  'channels',
  'users',
];

const MANAGED_ENUM_TYPES = [
  'videos_status_enum',
  'verification_tokens_type_enum',
];

// Drops sequentially rather than in parallel: a single connection cannot run
// concurrent queries, and dropping in parallel also races on the foreign keys
// that CASCADE removes.
async function dropManagedSchema(dataSource: DataSource): Promise<void> {
  for (const table of [...MANAGED_TABLES, 'migrations']) {
    await dataSource.query(`DROP TABLE IF EXISTS "${table}" CASCADE`);
  }
  for (const enumType of MANAGED_ENUM_TYPES) {
    await dataSource.query(`DROP TYPE IF EXISTS "${enumType}" CASCADE`);
  }
}

async function findManagedTables(
  dataSource: DataSource,
  tables: string[],
): Promise<string[]> {
  const rows = await dataSource.query<{ table_name: string }[]>(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_name = ANY($1::text[])
     ORDER BY table_name`,
    [tables],
  );
  return rows.map((row) => row.table_name);
}

describe('Database migrations (integration)', () => {
  let dataSource: DataSource;

  beforeAll(async () => {
    dataSource = createTestDataSource(
      [User, Channel, RefreshToken, VerificationToken, Video],
      { synchronize: false, migrations: ALL_MIGRATIONS },
    );

    await dataSource.initialize();
    await dropManagedSchema(dataSource);
  });

  afterAll(async () => {
    // The revert test leaves the schema partially torn down. Rebuild it from a
    // clean slate so the shared database is fully migrated for the suites that
    // run next, no matter which assertion above failed.
    await dropManagedSchema(dataSource);
    await dataSource.runMigrations();
    await dataSource.destroy();
  });

  it('should apply all migrations and create every managed table', async () => {
    const ranMigrations = await dataSource.runMigrations();

    expect(ranMigrations).toHaveLength(ALL_MIGRATIONS.length);

    const tableNames = await findManagedTables(dataSource, MANAGED_TABLES);
    expect(tableNames).toEqual([...MANAGED_TABLES].sort());
  });

  it('should revert the last migration and remove the videos table', async () => {
    await dataSource.undoLastMigration();

    const tableNames = await findManagedTables(dataSource, ['videos']);
    expect(tableNames).toHaveLength(0);
  });
});

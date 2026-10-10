import { afterAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db, one, pool } from '../apps/server/src/db';
import { migrate } from '../apps/server/src/db/migrate';
import { acceptInvitation, createInvitation, setUserDisabled } from '../apps/server/src/modules/accounts';
import * as projects from '../apps/server/src/modules/projects';
import * as resources from '../apps/server/src/modules/resources';
import type { Actor } from '../apps/server/src/modules/core';

afterAll(async () => { await pool.end(); });

async function fixture() {
  await migrate(process.env.TEST_DATABASE_URL);
  const actors: Actor[] = Array.from({ length: 3 }, () => ({ userId: randomUUID(), source: 'web' }));
  for (const actor of actors) {
    await db.execute(sql`INSERT INTO users(id,name,email,is_admin,identity_source) VALUES(${actor.userId},'Race test',${`${actor.userId}@example.test`},true,'invite')`);
  }
  return { admin: actors[0], member: actors[1], guest: actors[2] };
}

async function blocked(count: number) {
  await vi.waitFor(async () => {
    const result = await pool.query("SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'");
    expect(result.rows[0].count).toBeGreaterThanOrEqual(count);
  }, { timeout: 5000, interval: 20 });
}

describe('account suspension and team invitation races', () => {
  for (const disableFirst of [true, false]) {
    it(`serializes account suspension with a ${disableFirst ? 'later' : 'previously started'} task write`, async () => {
      const { admin, member } = await fixture();
      const project = await projects.createProject(admin, { name: 'Account race' }, randomUUID());
      await db.execute(sql`INSERT INTO project_members(project_id,user_id,role) VALUES(${project.id},${member.userId},'member')`);
      const task = await resources.createTask(admin, project.id, { title: 'Before suspension' }, randomUUID());
      const operation = randomUUID();
      const blocker = await pool.connect();
      let disabling: Promise<PromiseSettledResult<unknown>[]> | undefined;
      let writing: Promise<PromiseSettledResult<unknown>[]> | undefined;
      const disable = () => { disabling = Promise.allSettled([setUserDisabled(admin, member.userId, true, randomUUID())]); };
      const write = () => { writing = Promise.allSettled([resources.updateTask(member, project.id, task.id, { title: 'After write' }, 1, operation)]); };
      try {
        await blocker.query('BEGIN');
        await blocker.query('SELECT id FROM projects WHERE id=$1 FOR UPDATE', [project.id]);
        (disableFirst ? disable : write)();
        await blocked(1);
        (disableFirst ? write : disable)();
        await blocked(2);
        await blocker.query('COMMIT');
        expect((await disabling!)[0].status).toBe('fulfilled');
        const result = (await writing!)[0];
        if (disableFirst) {
          expect(result.status).toBe('rejected');
          expect((result as PromiseRejectedResult).reason.code).toBe('UNAUTHENTICATED');
        } else expect(result.status).toBe('fulfilled');
        expect(await resources.getResource(admin, project.id, 'task', task.id)).toMatchObject({
          title: disableFirst ? 'Before suspension' : 'After write', version: disableFirst ? 1 : 2,
        });
        expect((await resources.history(admin, project.id, 'task', task.id)).items).toHaveLength(disableFirst ? 1 : 2);
        expect((await one(db, sql`SELECT disabled FROM users WHERE id=${member.userId}`))?.disabled).toBe(true);
        await expect(resources.updateTask(member, project.id, task.id, { title: 'After write' }, 1, operation)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
      } finally {
        await blocker.query('ROLLBACK');
        blocker.release();
        await Promise.all([disabling, writing]);
      }
    });
  }

  for (const action of ['demote', 'remove', 'delete'] as const) {
    it(`rejects queued team invitation consumption after issuer ${action}`, async () => {
      const { admin, member, guest } = await fixture();
      const team = await projects.createTeam(admin, 'Invitation race', randomUUID());
      await db.execute(sql`INSERT INTO team_members(team_id,user_id,role) VALUES(${team.id},${member.userId},'admin')`);
      const invite = await createInvitation(member, 'team', team.id, `${guest.userId}@example.test`, 'member', randomUUID());
      const blocker = await pool.connect();
      let changing: Promise<PromiseSettledResult<unknown>[]> | undefined;
      let accepting: Promise<PromiseSettledResult<unknown>[]> | undefined;
      try {
        await blocker.query('BEGIN');
        await blocker.query('SELECT id FROM teams WHERE id=$1 FOR UPDATE', [team.id]);
        changing = Promise.allSettled([action === 'demote'
          ? projects.changeTeamRole(admin, team.id, member.userId, 'member', 'admin', randomUUID())
          : projects.manageTeam(admin, team.id, action === 'delete' ? 'delete' : 'remove_member', action === 'delete' ? null : member.userId, randomUUID())]);
        await blocked(1);
        accepting = Promise.allSettled([acceptInvitation(guest, new URL(invite.url).searchParams.get('token')!)]);
        await blocked(2);
        await blocker.query('COMMIT');
        expect((await changing)[0].status).toBe('fulfilled');
        const result = (await accepting)[0];
        expect(result.status).toBe('rejected');
        expect(['FORBIDDEN', 'NOT_FOUND']).toContain((result as PromiseRejectedResult).reason.code);
        expect(await one(db, sql`SELECT user_id FROM team_members WHERE team_id=${team.id} AND user_id=${guest.userId}`)).toBeUndefined();
        expect((await one(db, sql`SELECT accepted_at FROM invitations WHERE id=${invite.id}`))?.acceptedAt).toBeNull();
        expect(await one(db, sql`SELECT id FROM audit_events WHERE resource_id=${invite.id} AND operation='accept'`)).toBeUndefined();
      } finally {
        await blocker.query('ROLLBACK');
        blocker.release();
        await Promise.all([changing, accepting]);
      }
    });
  }
});

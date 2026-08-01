/**
 * Bounded HOOK-5. Nicht geschlossen:
 * newest-first >limit; 5/23+18 aeltere; order:oldest; mark_read(bis_id);
 * Altersstaffel; aelteste_alter_sek/Grenzfaelle. Diese brauchen Sparse-Receipts.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  claimUnreadChannelHints, closePool, createChannel, deleteChannel,
  getPool, joinChannel, leaveChannel, postChannelMessage, recordChannelRead,
} from '../dist/index.js'

async function assertHook5Schema() {
  const { rows } = await getPool().query(
    `SELECT COUNT(*)::int AS count
       FROM information_schema.columns
      WHERE table_name = 'specialist_channel_members'
        AND column_name = ANY($1::text[])`,
    [['last_read_message_id', 'last_notified_message_id', 'read_initialized_at']],
  )
  assert.equal(rows[0].count, 3, 'HOOK-5 Schema muss vor dem Integrationstest migriert sein')
}

test('HOOK-5 Cursor, Membership, Dedup und eigene Posts', async (t) => {
  await assertHook5Schema()
  const x = `${Date.now()}-${Math.random().toString(16).slice(2)}`
  const project = `hook5-test-${x}`, agent = `hook5-agent-${x}`
  const other = `hook5-other-${x}`, a = `hook5-a-${x}`, b = `hook5-b-${x}`
  t.after(async () => {
    await deleteChannel(project, a); await deleteChannel(project, b); await closePool()
  })
  await createChannel(project, a, 'A', other); await createChannel(project, b, 'B', other)
  await postChannelMessage(project, a, other, 'vor Join')
  assert.equal(await joinChannel(project, a, agent), true)
  assert.equal(await joinChannel(project, b, agent), true)
  assert.deepEqual(await claimUnreadChannelHints(agent), [])

  await postChannelMessage(project, a, agent, 'eigen')
  assert.deepEqual(await claimUnreadChannelHints(agent), [])
  const first = await postChannelMessage(project, a, other, 'fremd')
  const claimed = (await Promise.all(Array.from({ length: 8 }, () =>
    claimUnreadChannelHints(agent)))).flat()
  assert.equal(claimed.length, 1)
  assert.deepEqual(claimed[0], { project, channel: a, count: 1, newestId: first.id })
  assert.deepEqual(await claimUnreadChannelHints(agent), [])

  const cursors = await getPool().query(
    `SELECT last_read_message_id, last_notified_message_id
       FROM specialist_channel_members mem JOIN specialist_channels c ON c.id=mem.channel_id
      WHERE c.project=$1 AND c.name=$2 AND mem.agent_name=$3`, [project, a, agent])
  assert.notEqual(Number(cursors.rows[0].last_read_message_id),
    Number(cursors.rows[0].last_notified_message_id))

  const delivered = await postChannelMessage(project, a, other, 'ausgeliefert')
  assert.equal(await recordChannelRead(project, a, agent, [delivered.id]), true)
  assert.deepEqual(await claimUnreadChannelHints(agent), [])
  const missed = await postChannelMessage(project, a, other, 'N+1 fremd')
  await postChannelMessage(project, a, agent, 'N+2 eigen')
  assert.deepEqual(await claimUnreadChannelHints(agent),
    [{ project, channel: a, count: 1, newestId: missed.id }])

  const inB = await postChannelMessage(project, b, other, 'nur B')
  assert.deepEqual(await claimUnreadChannelHints(agent),
    [{ project, channel: b, count: 1, newestId: inB.id }])
  await postChannelMessage(project, b, other, 'B nach Claim')
  assert.equal(await leaveChannel(project, b, agent), true)
  assert.deepEqual(await claimUnreadChannelHints(agent), [])
  assert.deepEqual(await claimUnreadChannelHints(''), [])
})

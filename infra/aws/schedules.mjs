/**
 * Turn the AWS schedules for prems-apply and prems-inbox on or off.
 *
 *   npm run aws:schedules -- enable
 *   npm run aws:schedules -- disable
 *
 * They are created DISABLED. Enable them only once the matching Cloud Run jobs
 * are paused: two schedulers on the same outbox would send every application twice.
 */
import { SchedulerClient, GetScheduleCommand, UpdateScheduleCommand } from '@aws-sdk/client-scheduler';

const region = process.env.AWS_REGION ?? 'eu-west-3';
const action = process.argv[2];
if (action !== 'enable' && action !== 'disable') {
  console.error('usage: npm run aws:schedules -- enable|disable');
  process.exit(1);
}

const scheduler = new SchedulerClient({ region });
for (const Name of ['prems-apply', 'prems-inbox']) {
  const current = await scheduler.send(new GetScheduleCommand({ Name }));
  const { $metadata, Arn, CreationDate, LastModificationDate, ...input } = current;
  await scheduler.send(new UpdateScheduleCommand({ ...input, Name, State: action === 'enable' ? 'ENABLED' : 'DISABLED' }));
  console.log(`${Name}: ${action === 'enable' ? 'ENABLED' : 'DISABLED'} (${current.ScheduleExpression})`);
}

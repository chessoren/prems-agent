/**
 * Run one worker as a one-off ECS Fargate task, wait for it, and print its logs.
 *
 *   npm run aws:run -- smoke                                    # Supabase, Composio, Bedrock — sends nothing
 *   npm run aws:run -- demo DEMO_AGENCY_EMAIL=agency@example.com # the whole cycle every 8 s (see README)
 *   npm run aws:run -- apply | inbox                             # one production tick, by hand
 *
 * Uses the cluster, task definitions and network created by `npm run aws:stack`.
 */
import { ECSClient, RunTaskCommand, DescribeTasksCommand } from '@aws-sdk/client-ecs';
import { CloudWatchLogsClient, GetLogEventsCommand } from '@aws-sdk/client-cloudwatch-logs';
import { EC2Client, DescribeSubnetsCommand, DescribeSecurityGroupsCommand, DescribeVpcsCommand } from '@aws-sdk/client-ec2';

const region = process.env.AWS_REGION ?? 'eu-west-3';
const [mode = 'smoke', ...pairs] = process.argv.slice(2);
const environment = pairs.map((p) => {
  const i = p.indexOf('=');
  return { name: p.slice(0, i), value: p.slice(i + 1) };
});

const ecs = new ECSClient({ region });
const logs = new CloudWatchLogsClient({ region });
const ec2 = new EC2Client({ region });

const vpc = (await ec2.send(new DescribeVpcsCommand({ Filters: [{ Name: 'isDefault', Values: ['true'] }] }))).Vpcs[0].VpcId;
const subnets = (
  await ec2.send(new DescribeSubnetsCommand({ Filters: [{ Name: 'vpc-id', Values: [vpc] }, { Name: 'default-for-az', Values: ['true'] }] }))
).Subnets.map((s) => s.SubnetId);
const sg = (
  await ec2.send(new DescribeSecurityGroupsCommand({ Filters: [{ Name: 'vpc-id', Values: [vpc] }, { Name: 'group-name', Values: ['default'] }] }))
).SecurityGroups[0].GroupId;

/** Reads only: one row of settings, Composio's permission check, one model turn. */
const SMOKE = `
const out = {};
try { const { db } = await import('/app/workers/dist/db.js'); const r = await db().from('settings').select('agent_replies_enabled,max_agent_replies_per_thread').eq('id', 1).single(); out.supabase = r.error ? 'ERR ' + r.error.message : r.data; } catch (e) { out.supabase = 'ERR ' + e.message; }
try { const { canExecute } = await import('/app/workers/dist/composio.js'); out.composio = await canExecute(); } catch (e) { out.composio = 'ERR ' + e.message; }
try { const { probeModel, MODEL } = await import('/app/workers/dist/agent.js'); out.model = MODEL; out.bedrock = await probeModel(MODEL); } catch (e) { out.bedrock = 'ERR ' + String(e.message).slice(0, 220); }
console.log('SMOKE ' + JSON.stringify(out));
`;

const taskDefinition = mode === 'smoke' ? 'prems-demo' : `prems-${mode}`;
const override = { name: 'worker', environment };
if (mode === 'smoke') override.command = ['node', '--input-type=module', '-e', SMOKE];

const run = await ecs.send(
  new RunTaskCommand({
    cluster: 'prems',
    taskDefinition,
    launchType: 'FARGATE',
    count: 1,
    networkConfiguration: { awsvpcConfiguration: { subnets, securityGroups: [sg], assignPublicIp: 'ENABLED' } },
    overrides: { containerOverrides: [override] },
  }),
);
if (run.failures?.length) throw new Error(JSON.stringify(run.failures));

const arn = run.tasks[0].taskArn;
const id = arn.split('/').pop();
console.log(`task ${id} (${taskDefinition})`);

let task;
let seen = 0;
const stream = `${taskDefinition.replace('prems-', '')}/worker/${id}`;
for (;;) {
  await new Promise((r) => setTimeout(r, 8000));
  task = (await ecs.send(new DescribeTasksCommand({ cluster: 'prems', tasks: [arn] }))).tasks[0];
  try {
    const { events } = await logs.send(new GetLogEventsCommand({ logGroupName: '/ecs/prems-workers', logStreamName: stream, startFromHead: true }));
    for (const e of events.slice(seen)) console.log(e.message);
    seen = events.length;
  } catch {
    /* the stream appears once the container starts */
  }
  if (task.lastStatus === 'STOPPED') break;
}
const exit = task.containers?.[0]?.exitCode;
console.log(`stopped: ${task.stoppedReason} · exit ${exit}`);
process.exit(exit === 0 ? 0 : 1);

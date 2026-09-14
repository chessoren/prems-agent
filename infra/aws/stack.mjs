/**
 * The AWS side of Prems, idempotent: run it again and it converges.
 *
 *   npm run aws:stack
 *
 * Creates, in AWS_REGION (eu-west-3 by default):
 *  - Secrets Manager: prems/supabase-service-role-key, prems/composio-api-key (from .env)
 *  - IAM: prems-ecs-execution (pulls the image, reads the two secrets),
 *         prems-ecs-task (bedrock:InvokeModel / Converse — the agents' only credential),
 *         prems-scheduler (runs the two scheduled tasks)
 *  - CloudWatch Logs: /ecs/prems-workers
 *  - ECS Fargate cluster prems, task definitions prems-apply, prems-inbox, prems-demo
 *  - EventBridge Scheduler: prems-apply every 2 min, prems-inbox 08:00 Europe/Paris — DISABLED
 *
 * The image comes from .
 */
import { IAMClient, CreateRoleCommand, GetRoleCommand, AttachRolePolicyCommand, PutRolePolicyCommand } from '@aws-sdk/client-iam';
import { ECSClient, CreateClusterCommand, RegisterTaskDefinitionCommand } from '@aws-sdk/client-ecs';
import { CloudWatchLogsClient, CreateLogGroupCommand, PutRetentionPolicyCommand } from '@aws-sdk/client-cloudwatch-logs';
import { SecretsManagerClient, CreateSecretCommand, DescribeSecretCommand, PutSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { EC2Client, DescribeSubnetsCommand, DescribeSecurityGroupsCommand } from '@aws-sdk/client-ec2';
import { SchedulerClient, CreateScheduleCommand, UpdateScheduleCommand } from '@aws-sdk/client-scheduler';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { DescribeVpcsCommand } from '@aws-sdk/client-ec2';
const region = process.env.AWS_REGION ?? 'eu-west-3';
const account = (await new STSClient({ region }).send(new GetCallerIdentityCommand({}))).Account;
const iam = new IAMClient({ region: 'us-east-1' }), ecs = new ECSClient({ region }), logs = new CloudWatchLogsClient({ region });
const sm = new SecretsManagerClient({ region }), ec2 = new EC2Client({ region }), sch = new SchedulerClient({ region });
const vpc = (await ec2.send(new DescribeVpcsCommand({ Filters: [{ Name: 'isDefault', Values: ['true'] }] }))).Vpcs[0].VpcId;
if (!process.env.SUPABASE_SERVICE_ROLE_KEY) throw new Error('SUPABASE_SERVICE_ROLE_KEY manquant dans .env');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function role(name, service, managed = [], inline = null) {
  let arn;
  try { arn = (await iam.send(new GetRoleCommand({ RoleName: name }))).Role.Arn; }
  catch { arn = (await iam.send(new CreateRoleCommand({ RoleName: name, AssumeRolePolicyDocument: JSON.stringify({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: { Service: service }, Action: 'sts:AssumeRole' }] }) }))).Role.Arn; }
  for (const p of managed) await iam.send(new AttachRolePolicyCommand({ RoleName: name, PolicyArn: p }));
  if (inline) await iam.send(new PutRolePolicyCommand({ RoleName: name, PolicyName: `${name}-inline`, PolicyDocument: JSON.stringify(inline) }));
  return arn;
}
async function secret(name, value, overwrite) {
  try { const d = await sm.send(new DescribeSecretCommand({ SecretId: name })); if (overwrite) await sm.send(new PutSecretValueCommand({ SecretId: name, SecretString: value })); return d.ARN; }
  catch { return (await sm.send(new CreateSecretCommand({ Name: name, SecretString: value }))).ARN; }
}
const supabaseArn = await secret('prems/supabase-service-role-key', process.env.SUPABASE_SERVICE_ROLE_KEY, true);
const composioArn = await secret('prems/composio-api-key', process.env.COMPOSIO_API_KEY || 'PENDING', Boolean(process.env.COMPOSIO_API_KEY));
console.log('secrets ok');
const execRole = await role('prems-ecs-execution', 'ecs-tasks.amazonaws.com', ['arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy'],
  { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: 'secretsmanager:GetSecretValue', Resource: [supabaseArn, composioArn] }] });
const taskRole = await role('prems-ecs-task', 'ecs-tasks.amazonaws.com', [],
  { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream', 'bedrock:Converse', 'bedrock:ConverseStream'], Resource: '*' }] });
console.log('roles', execRole, taskRole);
try { await logs.send(new CreateLogGroupCommand({ logGroupName: '/ecs/prems-workers' })); } catch (e) { if (e.name !== 'ResourceAlreadyExistsException') throw e; }
await logs.send(new PutRetentionPolicyCommand({ logGroupName: '/ecs/prems-workers', retentionInDays: 30 }));
try { const { CreateServiceLinkedRoleCommand } = await import("@aws-sdk/client-iam"); await iam.send(new CreateServiceLinkedRoleCommand({ AWSServiceName: "ecs.amazonaws.com" })); console.log("ecs service-linked role created"); await sleep(10000); } catch (e) { console.log("service-linked role:", e.name); }
let cluster;
for (let i = 0; i < 12; i++) { try { cluster = (await ecs.send(new CreateClusterCommand({ clusterName: "prems", capacityProviders: ["FARGATE"] }))).cluster.clusterArn; break; } catch (e) { if (i === 11) throw e; console.log("retry cluster", e.name); await sleep(5000); } }
console.log('cluster', cluster);
const image = `${account}.dkr.ecr.${region}.amazonaws.com/prems-workers:latest`;
const taskDefs = {};
for (const mode of ['apply', 'inbox', 'demo']) {
  for (let i = 0; i < 10; i++) {
    try {
      const td = await ecs.send(new RegisterTaskDefinitionCommand({
        family: `prems-${mode}`, requiresCompatibilities: ['FARGATE'], networkMode: 'awsvpc', cpu: '512', memory: '1024',
        runtimePlatform: { cpuArchitecture: 'X86_64', operatingSystemFamily: 'LINUX' },
        executionRoleArn: execRole, taskRoleArn: taskRole,
        containerDefinitions: [{
          name: 'worker', image, essential: true,
          environment: [
            { name: 'MODE', value: mode },
            { name: 'SUPABASE_URL', value: process.env.SUPABASE_URL ?? 'https://budbfhrqdeghyufeizpv.supabase.co' },
            { name: 'AWS_REGION', value: region },
            { name: 'BEDROCK_MODEL_ID', value: process.env.BEDROCK_MODEL_ID ?? 'eu.anthropic.claude-sonnet-5' },
          ],
          secrets: [
            { name: 'SUPABASE_SERVICE_ROLE_KEY', valueFrom: supabaseArn },
            { name: 'COMPOSIO_API_KEY', valueFrom: composioArn },
          ],
          logConfiguration: { logDriver: 'awslogs', options: { 'awslogs-group': '/ecs/prems-workers', 'awslogs-region': region, 'awslogs-stream-prefix': mode } },
        }],
      }));
      taskDefs[mode] = td.taskDefinition.taskDefinitionArn; break;
    } catch (e) { if (i === 9) throw e; console.log('retry task def', e.name, e.message.slice(0, 80)); await sleep(5000); }
  }
}
console.log('task defs', taskDefs);
const subnets = (await ec2.send(new DescribeSubnetsCommand({ Filters: [{ Name: 'vpc-id', Values: [vpc] }, { Name: 'default-for-az', Values: ['true'] }] }))).Subnets.map((s) => s.SubnetId);
const sg = (await ec2.send(new DescribeSecurityGroupsCommand({ Filters: [{ Name: 'vpc-id', Values: [vpc] }, { Name: 'group-name', Values: ['default'] }] }))).SecurityGroups[0].GroupId;
console.log('network', subnets, sg);
const schedRole = await role('prems-scheduler', 'scheduler.amazonaws.com', [],
  { Version: '2012-10-17', Statement: [
    { Effect: 'Allow', Action: 'ecs:RunTask', Resource: [`arn:aws:ecs:${region}:${account}:task-definition/prems-apply*`, `arn:aws:ecs:${region}:${account}:task-definition/prems-inbox*`] },
    { Effect: 'Allow', Action: 'iam:PassRole', Resource: [execRole, taskRole] }] });
const schedules = [
  { name: 'prems-apply', expr: 'rate(2 minutes)', td: taskDefs.apply },
  { name: 'prems-inbox', expr: 'cron(0 8 * * ? *)', td: taskDefs.inbox },
];
for (const s of schedules) {
  const input = {
    Name: s.name, ScheduleExpression: s.expr, ScheduleExpressionTimezone: 'Europe/Paris', State: 'DISABLED', FlexibleTimeWindow: { Mode: 'OFF' },
    Description: 'Prems worker on ECS Fargate. Enabled only once the matching Cloud Run job is paused.',
    Target: { Arn: cluster, RoleArn: schedRole, RetryPolicy: { MaximumRetryAttempts: 0 },
      EcsParameters: { TaskDefinitionArn: s.td.replace(/:\d+$/, ''), LaunchType: 'FARGATE', TaskCount: 1,
        NetworkConfiguration: { awsvpcConfiguration: { Subnets: subnets, SecurityGroups: [sg], AssignPublicIp: 'ENABLED' } } } },
  };
  for (let i = 0; i < 12; i++) {
    try { try { await sch.send(new CreateScheduleCommand(input)); } catch (e) { if (e.name === 'ConflictException') await sch.send(new UpdateScheduleCommand(input)); else throw e; } console.log('schedule', s.name, 'DISABLED'); break; }
    catch (e) { if (i === 11) throw e; console.log('retry schedule', e.name, e.message.slice(0, 80)); await sleep(5000); }
  }
}
console.log(JSON.stringify({ cluster, subnets, sg, taskDefs }));

/**
 * Build the workers image from the public GitHub repository with CodeBuild and
 * push it to ECR (prems-workers:latest). No Docker needed locally.
 *
 *   npm run aws:image
 */
import { ECRClient, CreateRepositoryCommand, DescribeRepositoriesCommand } from '@aws-sdk/client-ecr';
import { IAMClient, CreateRoleCommand, GetRoleCommand, AttachRolePolicyCommand } from '@aws-sdk/client-iam';
import { CodeBuildClient, CreateProjectCommand, UpdateProjectCommand, StartBuildCommand } from '@aws-sdk/client-codebuild';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { BatchGetBuildsCommand } from '@aws-sdk/client-codebuild';
const region = process.env.AWS_REGION ?? 'eu-west-3', repo = 'prems-workers';
const account = (await new STSClient({ region }).send(new GetCallerIdentityCommand({}))).Account;
const ecr = new ECRClient({ region }), iam = new IAMClient({ region: 'us-east-1' }), cb = new CodeBuildClient({ region });
let uri;
try { uri = (await ecr.send(new DescribeRepositoriesCommand({ repositoryNames: [repo] }))).repositories[0].repositoryUri; }
catch { uri = (await ecr.send(new CreateRepositoryCommand({ repositoryName: repo, imageScanningConfiguration: { scanOnPush: true } }))).repository.repositoryUri; }
console.log('ECR', uri);
const roleName = 'prems-codebuild';
let roleArn;
try { roleArn = (await iam.send(new GetRoleCommand({ RoleName: roleName }))).Role.Arn; }
catch {
  roleArn = (await iam.send(new CreateRoleCommand({ RoleName: roleName, AssumeRolePolicyDocument: JSON.stringify({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: { Service: 'codebuild.amazonaws.com' }, Action: 'sts:AssumeRole' }] }) }))).Role.Arn;
  for (const p of ['arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryPowerUser', 'arn:aws:iam::aws:policy/CloudWatchLogsFullAccess'])
    await iam.send(new AttachRolePolicyCommand({ RoleName: roleName, PolicyArn: p }));
}
console.log('role', roleArn);
const buildspec = `version: 0.2
phases:
  pre_build:
    commands:
      - aws ecr get-login-password --region ${region} | docker login --username AWS --password-stdin ${account}.dkr.ecr.${region}.amazonaws.com
      - git clone --depth 1 https://github.com/chessoren/prems-agent.git /tmp/src
  build:
    commands:
      - sed -i 's#FROM node:22-slim#FROM public.ecr.aws/docker/library/node:22-slim#' /tmp/src/workers/Dockerfile
      - docker build -f /tmp/src/workers/Dockerfile -t ${uri}:latest -t ${uri}:$(git -C /tmp/src rev-parse --short HEAD) /tmp/src
  post_build:
    commands:
      - docker push --all-tags ${uri}
`;
const project = {
  name: 'prems-workers-image', source: { type: 'NO_SOURCE', buildspec }, artifacts: { type: 'NO_ARTIFACTS' },
  environment: { type: 'LINUX_CONTAINER', image: 'aws/codebuild/amazonlinux-x86_64-standard:5.0', computeType: 'BUILD_GENERAL1_MEDIUM', privilegedMode: true },
  serviceRole: roleArn, timeoutInMinutes: 30,
};
for (let i = 0; i < 12; i++) {
  try {
    try { await cb.send(new CreateProjectCommand(project)); } catch (e) { if (e.name === 'ResourceAlreadyExistsException') await cb.send(new UpdateProjectCommand(project)); else throw e; }
    break;
  } catch (e) { if (i === 11) throw e; console.log('waiting for IAM role…', e.name); await new Promise(r => setTimeout(r, 5000)); }
}
const b = await cb.send(new StartBuildCommand({ projectName: 'prems-workers-image' }));
console.log('build started', b.build.id);
for (;;) {
  await new Promise((r) => setTimeout(r, 15000));
  const s = (await cb.send(new BatchGetBuildsCommand({ ids: [b.build.id] }))).builds[0];
  console.log(s.currentPhase, s.buildStatus);
  if (s.buildStatus !== 'IN_PROGRESS') process.exit(s.buildStatus === 'SUCCEEDED' ? 0 : 1);
}

# Partner AWS Account — Deploy Setup

This guide covers the one-time setup needed when deploying CIRL into an AWS account you don't own (e.g. a customer or partner account). The goal is to deploy CIRL **without ever holding the partner's root or admin credentials** — and without asking the partner to grant you `AdministratorAccess`.

The approach uses the standard CDK Bootstrap pattern: the partner runs a one-time bootstrap that creates a set of IAM roles in their account, and your IAM user is granted `sts:AssumeRole` on those roles. Your user has narrow direct permissions (just enough to inspect the deployed system), and CDK takes care of the privileged operations through assumed roles.

---

## Steps for the partner

The partner runs these steps once, with their own admin-level credentials.

### 1. Bootstrap CDK in their account

```bash
npm install -g aws-cdk
cdk bootstrap aws://<account-id>/<region>
```

This creates a CloudFormation stack named `CDKToolkit` containing an S3 staging bucket, IAM roles (`cdk-hnb659fds-deploy-role-*`, `cdk-hnb659fds-cfn-exec-role-*`, etc.), and an SSM parameter tracking the bootstrap version. Takes ~2 minutes. The same scaffolding can be reused by any future CDK app deployed into the account.

> **CDK qualifier**: by default the bootstrap uses qualifier `hnb659fds` (a fixed AWS-chosen string). If the partner has another team also using CDK in the same account/region, they may have used a custom qualifier to avoid name collisions. If they did, ask them which qualifier was used. You'll need to pass it during deploy:
> ```bash
> npm run deploy -- --context env=inter --context @aws-cdk/core:bootstrapQualifier=<their-qualifier>
> ```
> If they bootstrap fresh in a clean region for you, they can either accept the default or pass their own with `cdk bootstrap --qualifier <something> ...`. Either is fine — just make sure both sides agree on which one is in use.

### 2. Create an IAM user for the deployer

In the AWS Console: IAM → Users → Create user.
- Username: e.g. `cirl-deployer`
- Access type: programmatic access (Access Key + Secret Access Key)

### 3. Attach the scoped deploy policy

Attach [`cdk-deploy-policy.json`](./cdk-deploy-policy.json) as an inline policy on the new user.

The policy grants:
- `sts:AssumeRole` on `cdk-*` roles only — this is how all deploy-side operations actually run.
- Read-only CloudFormation visibility — for inspecting stack state.
- Operational permissions on the resources CIRL deploys — DynamoDB queries for debugging, CloudWatch Logs tailing, API Gateway key retrieval, Lambda config inspection, etc.

The policy explicitly does **not** grant the deployer the ability to create/modify IAM users, modify the bootstrap roles themselves, or touch resources outside the CIRL footprint.

### 4. Send credentials to the deployer

Share the Access Key ID + Secret Access Key over a secure channel (1Password share, AWS IAM Identity Center, or an equivalent — **not** plain Slack/email).

Also send:
- The 12-digit AWS account ID
- The target region (e.g. `sa-east-1`)
- The CDK qualifier if non-default

---

## Steps for the deployer

Once you have the credentials:

### 1. Configure a named AWS profile

```bash
aws configure --profile inter-partner
# AWS Access Key ID:     <paste from partner>
# AWS Secret Access Key: <paste from partner>
# Default region name:   sa-east-1
# Default output format: json
```

### 2. Verify the credentials work

```bash
AWS_PROFILE=inter-partner aws sts get-caller-identity
```

Should print the partner's account number and your IAM user ARN.

### 3. Deploy

From the repo root:

```bash
export AWS_PROFILE=inter-partner
export DOTENV_CONFIG_PATH=$(pwd)/.env.inter
cd infra/cdk && npm run deploy -- --context env=inter
```

If the partner used a custom CDK qualifier, append it:

```bash
npm run deploy -- --context env=inter --context @aws-cdk/core:bootstrapQualifier=<their-qualifier>
```

---

## Things to ask the partner up front

These come up routinely and unblock deploy faster if surfaced early:

1. **Region** — confirm the deploy target. For Brazilian customers (e.g. Inter), `sa-east-1` is typical for data residency.
2. **CDK qualifier** — default `hnb659fds`, or are they using a custom one?
3. **Service Control Policies (SCPs)** — if they're in an AWS Organization, an org-level SCP may block resources the stack creates (customer-managed KMS keys, on-demand DynamoDB billing mode, certain Lambda runtimes, etc.). A copy of the SCP is the fastest way to spot issues before they surface as a confusing CloudFormation error.
4. **Permissions boundaries** — some enterprises require that all newly created IAM roles attach a specific permissions boundary. If so, the bootstrap roles need it too:
   ```bash
   cdk bootstrap --custom-permissions-boundary <boundary-name> aws://<account>/<region>
   ```
5. **Budget alarm** — recommend they set a monthly budget alarm on the account (e.g. $50). The AWS infra cost for CIRL at MVP volumes is ~$5/month, but Twilio CI charges may show up here too if the partner buys via AWS Marketplace.

---

## Why not just use AdministratorAccess?

It's simpler, but most enterprise customers won't grant it for a non-employee. Even if they would, this approach is cleaner:

- Audit trail is clearer — every privileged action runs as an assumed CDK role, not as your user, so CloudTrail shows it as `cdk-deploy-role-...` rather than `cirl-deployer`.
- Blast radius is bounded — a leaked deploy-user credential can only assume the bootstrap roles in the partner's account, not perform arbitrary actions.
- The partner's security review is shorter — the policy is small enough to read end-to-end and the privileged operations all flow through the standard, well-known CDK Bootstrap roles which the partner has already vetted via the bootstrap step.

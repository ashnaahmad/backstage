# pi-cloud-agents in Backstage

A modified source snapshot of [AntApper/pi-cloud-agents](https://github.com/AntApper/pi-cloud-agents), based on commit `cf75c94`, with an AWS runner and a one-shot scheduling integration. It retains the upstream [MIT licence](LICENSE).

This is an experimental component. Use [Backstage's cloud setup instructions](../SETUP.md#aws-cloud-agent-experiment) for configuration and current limitations. The upstream package description is not a verification record for this modified setup. Cloud deployments and runs incur AWS and provider costs.

See [bounded-assignment verification](docs/evidence/personal-assignment-round-trip.md) for exact-commit launch, durable answers and Git recovery without publication. There is no local attach view or cross-VM restore; unattended OAuth renewal remains unverified.

## Source layout

- `cli/` and `core/`: local configuration, deployment and run management
- `runner/` and `image/`: remote agent runtime and image
- `extension/`: `cloud_agent` assignment tool and `/cloud` run controls (`list`, `status`, `stop`, `suspend`, `resume`, `logs`, `pr`, `help`). Setup and configuration use the standalone CLI.
- `scheduled/`: one-shot task scheduling and result retrieval
- `infra/`: infrastructure templates
- `shared/` and `docs/schemas/`: shared contracts
- `tests/`: unit and integration checks

Messages and help use `pi-cloud-agents <command>` for the CLI. From a built source checkout, run `node dist/cli/main.js <command>` instead.

## Development

```sh
npm ci
npm run build
npm run typecheck
npm run test:unit
```

Deployment, AWS probes and cleanup scripts are separate operations; inspect their target account and resources before invoking them. Unit checks do not establish that a cloud deployment or provider authentication works.

See [IAM](docs/iam.md), [networking](docs/networking.md), [protocol](docs/protocol.md) and [threat model](docs/threat-model.md) for technical details. Historical plans and execution logs are not included in this snapshot.

# Tusk Test Runner

<p align="center">
  <a href="https://usetusk.ai">
    <img src="./static/images/tusk.png" width="200" title="Tusk">
  </a>
</p>

<div align="center">

[![lint](https://github.com/Use-Tusk/test-runner/actions/workflows/linter.yml/badge.svg?branch=main&event=push)](https://github.com/Use-Tusk/test-runner/actions/workflows/linter.yml?query=branch%3Amain)
[![build](https://github.com/Use-Tusk/test-runner/actions/workflows/codeql-analysis.yml/badge.svg?branch=main&event=push)](https://github.com/Use-Tusk/test-runner/actions/workflows/codeql-analysis.yml?query=branch%3Amain)
[![X (formerly Twitter) URL](https://img.shields.io/twitter/url?url=https%3A%2F%2Fx.com%2Fusetusk&style=flat&logo=x&label=Tusk&color=BF40BF)](https://x.com/usetusk)

</div>

Tusk is an AI testing platform that helps you catch blind spots, surface edge cases cases, and write verified tests for your commits.

This GitHub Action facilitates running Tusk-generated tests on Github runners.

## Usage

Log in to [Tusk](https://app.usetusk.ai/app) and auth your GitHub repo.

When you push new commits, Tusk runs against your commit changes and generates tests. To ensure that test scenarios are meaningful and verified, Tusk will start this workflow and provision a runner (with a unique `runId`), using it as an ephemeral sandbox to run tests against your specific setup and dependencies. Essentially, this action polls for live commands emitted by Tusk based on the progress of the run, executes them, and sends the results back to Tusk for further processing.

Add the following workflow to your `.github/workflows` folder and adapt inputs accordingly. If your repo requires additional setup steps (e.g., installing dependencies, setting up a Postgres database, etc), add them before the `Start runner` step. If your repo is a monorepo with multiple services, each workflow corresponds to a service sub-directory when you set up Tusk.

```yml
name: Tusk Test Runner

on:
  workflow_dispatch:
    inputs:
      runId:
        description: "Tusk Run ID"
        required: true
      tuskUrl:
        description: "Tusk server URL"
        required: true
      commitSha:
        description: "Commit SHA to checkout"
        required: true

jobs:
  test-action:
    name: Tusk Test Runner
    runs-on: ubuntu-latest

    steps:
      - name: Checkout
        id: checkout
        uses: actions/checkout@v4
        with:
          ref: ${{ github.event.inputs.commitSha }}

      - name: Install dependencies
        run: pip install -r requirements.txt

      - name: Start runner
        id: test-action
        uses: UseTusk/test-runner@v1
        with:
          runId: ${{ github.event.inputs.runId }}
          tuskUrl: ${{ github.event.inputs.tuskUrl }}
          commitSha: ${{ github.event.inputs.commitSha }}
          authToken: ${{ secrets.TUSK_AUTH_TOKEN }}
          lintScript: "black {{file}}"
          testScript: "pytest {{file}}"
          coverageScript: |
            coverage run -m pytest {{testFilePaths}}
            coverage json -o coverage.json
```

The test runner step takes as input these parameters:

- `runId`
  - From workflow dispatch
- `tuskUrl`
  - From workflow dispatch
- `commitSha`
  - From workflow dispatch
- `authToken`
  - Your Tusk API key
  - In the above example, this is stored as a GitHub repo secret
- `lintScript`
  - Command to execute to lint (fix) a file
  - Optional
- `testScript`
  - Command to execute to run tests in a file
- `coverageScript`
  - Command to execute to obtain coverage gain based on newly generated test files
  - Optional

In your lint and test scripts, use `{{file}}` as a placeholder for where a specific file path will be inserted. If you provide a coverage script, use `{{testFilePaths}}` as a placeholder for where generated test file paths will be inserted. These will be replaced by actual paths for test files that Tusk is working on at runtime.

For calculating test coverage gains, we support Pytest and Jest at the moment.

- For Pytest, your coverage script should write coverage data into `coverage.json` (the default file for Pytest). In the above example, we assume the `coverage` package is installed as part of the project requirements.
- For Jest, your coverage script should write coverage data into `coverage-summary.json` (the default file for Jest).

  Example:

  ```
  npm run test {{testFilePaths}} -- --coverage --coverageReporters=json-summary
  ```

## Contact

Need help? Drop us an email at support@usetusk.ai.

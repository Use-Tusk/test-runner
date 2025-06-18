# Tusk Test Runner

<p align="center">
  <a href="https://usetusk.ai">
    <img src="./static/images/tusk.png" width="200" title="Tusk">
  </a>
</p>

<div align="center">

[![docs](https://img.shields.io/badge/Docs-gray?style=plastic&logo=readthedocs&logoColor=white)](https://docs.usetusk.ai/automated-tests/self-serve)
[![lint](https://github.com/Use-Tusk/test-runner/actions/workflows/linter.yml/badge.svg?branch=main&event=push)](https://github.com/Use-Tusk/test-runner/actions/workflows/linter.yml?query=branch%3Amain)
[![build](https://github.com/Use-Tusk/test-runner/actions/workflows/codeql-analysis.yml/badge.svg?branch=main&event=push)](https://github.com/Use-Tusk/test-runner/actions/workflows/codeql-analysis.yml?query=branch%3Amain)
[![X (formerly Twitter) URL](https://img.shields.io/twitter/url?url=https%3A%2F%2Fx.com%2Fusetusk&style=flat&logo=x&label=Tusk&color=BF40BF)](https://x.com/usetusk)

</div>

Tusk is an AI testing platform that helps you catch blind spots, surface edge cases cases, and write verified tests for your commits.

This GitHub Action facilitates running Tusk-generated tests on Github runners.

## Usage

Onboard to the Tusk platform:

- Set your team up on Tusk [[docs](https://docs.usetusk.ai/automated-tests/onboarding)].
- Configure and validate your test execution environment (including a workflow that uses this action) through the setup wizard [[docs](https://docs.usetusk.ai/automated-tests/self-serve)].

When you push new commits, Tusk runs against your commit changes and generates tests. To ensure that test scenarios are meaningful and verified, Tusk will start this workflow and provision a runner (with a unique `runId`), using it as an ephemeral sandbox to run tests against your specific setup and dependencies. Essentially, this action polls for live commands emitted by Tusk based on the progress of the run, executes them, and sends the results back to Tusk for further processing.

Add the following workflow to your `.github/workflows` folder and adapt inputs accordingly. If your repo requires additional setup steps (e.g., installing dependencies, setting up a Postgres database, etc), add them before the `Start runner` step. If your repo is a monorepo with multiple services, each workflow corresponds to a service sub-directory when you set up Tusk.

Workflow examples:

- [Testing for a single-service repo](examples/pytest.yml)
- [Testing for a particular service in a multi-service repo](examples/jest-with-app-dir.yml)
- [Setting up auxiliary testing dependencies (e.g., Postgres DB, Redis)](examples/jest-with-service-dependencies.yml)
- [Using external runners in workflows (e.g., Blacksmith)](examples/pytest-with-blacksmith.yml)

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
        uses: Use-Tusk/test-runner@v1
        with:
          runId: ${{ github.event.inputs.runId }}
          tuskUrl: ${{ github.event.inputs.tuskUrl }}
          commitSha: ${{ github.event.inputs.commitSha }}
          authToken: ${{ secrets.TUSK_AUTH_TOKEN }}
          appDir: "backend"
          testFramework: "pytest"
          testFileRegex: "^backend/tests/.*(test_.*|.*_test).py$"
          lintScript: "black {{file}}"
          testScript: "pytest {{file}}"
          coverageScript: |
            coverage run -m pytest {{testFilePaths}}
            coverage json -o coverage.json
```

The test runner step takes as input these parameters:

<table>
  <thead>
    <tr>
      <th>Parameter</th>
      <th>Description</th>
      <th>Example</th>
      <th>Notes</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td><code>runId</code></td>
      <td>Tusk Run ID</td>
      <td><code>${{ github.event.inputs.runId }}</code></td>
      <td><b>Required.</b> Value passed in from workflow dispatch.</td>
    </tr>
    <tr>
      <td><code>tuskUrl</code></td>
      <td>Tusk server URL</td>
      <td><code>${{ github.event.inputs.tuskUrl }}</code></td>
      <td><b>Required.</b> Value passed in from workflow dispatch.</td>
    </tr>
    <tr>
      <td><code>commitSha</code></td>
      <td>Commit SHA to checkout</td>
      <td><code>${{ github.event.inputs.commitSha }}</code></td>
      <td><b>Required.</b> Value passed in from workflow dispatch.</td>
    </tr>
    <tr>
      <td><code>authToken</code></td>
      <td>Your Tusk API key</td>
      <td><code>${{ secrets.TUSK_AUTH_TOKEN }}</code></td>
      <td><b>Required.</b> Recommended to store as a GitHub secret</td>
    </tr>
    <tr>
      <td><code>appDir</code></td>
      <td>App directory for the service, if you have multiple services in the repo.</td>
      <td><code>backend</code></td>
      <td>Optional</td>
    </tr>
    <tr>
      <td><code>testFramework</code></td>
      <td>Test framework used for your service</td>
      <td><code>pytest</code> / <code>jest</code> / <code>vitest</code> / <code>rspec</code> / etc</td>
      <td><b>Required.</b></td>
    </tr>
    <tr>
      <td><code>testFileRegex</code></td>
      <td>Regex pattern to match test file paths in your repo (or app directory).</td>
      <td><code>^backend/tests/.*(test_.*|.*_test)\.py$</code></td>
      <td><b>Required.</b> This is relative to the root of the repo (i.e., the <code>appDir</code> will be included in it, if applicable).<br><br>If your pattern includes backslashes (<code>\</code>) to escape certain characters, wrap your pattern in single quotes or omit quotes entirely.</td>
    </tr>
    <tr>
      <td><code>lintScript</code></td>
      <td>Command to execute to lint (fix) a file. Use <code>{{file}}</code> as a placeholder.</td>
       <td><code>black {{file}}</code></td>
      <td>Optional</td>
    </tr>
    <tr>
      <td><code>testScript</code></td>
      <td>Command to execute to run tests in a file. Use <code>{{file}}</code> as a placeholder.</td>
      <td><code>pytest {{file}}</code></td>
      <td><b>Required.</b></td>
    </tr>
    <tr>
      <td><code>coverageScript</code></td>
      <td>Command to execute to obtain coverage gain based on newly generated test files. Use <code>{{testFilePaths}}</code> as placeholder.</td>
      <td><code>coverage run -m pytest {{testFilePaths}}<br>coverage json -o coverage.json</code></td>
      <td>Optional. Only supported if <code>testFramework</code> is <code>pytest</code> or <code>jest</code> at the moment.</td>
    </tr>
  </tbody>
</table>

In your lint and test scripts, use `{{file}}` as a placeholder for where a specific file path will be inserted. If you provide a coverage script, use `{{testFilePaths}}` as a placeholder for where generated test file paths will be inserted. These will be replaced by actual paths for test files that Tusk is working on at runtime.

For calculating test coverage gains, we support Pytest and Jest at the moment.

- For Pytest, your coverage script should write coverage data into `coverage.json` (the default file for Pytest). In the above example, we assume the `coverage` package is installed as part of the project requirements.
- For Jest, your coverage script should write coverage data into `coverage-summary.json` (the default file for Jest).

  Example:

  ```
  npm run test {{testFilePaths}} -- --coverage --coverageReporters=json-summary
  ```

## Advanced Configuration

### Additional inputs

The test runner step also takes these optional inputs to further configure the command polling behavior. In general, we recommend to leave them as they are unless you have a specific reason to deviate from these defaults.

- `pollingDuration`: How long to poll for commands (in seconds). Defaults to "3600".
- `pollingInterval`: How often to poll for commands (in seconds). Defaults to "5".
- `maxConcurrency`: Maximum number of commands to run concurrently. Defaults to "5".

### Using multiple jobs as parallel runners

We support using `strategy: matrix` to set up concurrent jobs. Each job will serve as a runner for test execution.

Set:

- `on.workflow_dispatch.inputs.runnerIndexes`
- `jobs.<action>.strategy.matrix.runnerIndex`
- `jobs.<action>.steps.<Tusk step>.with.runnerIndex`

to the values in the example shown below.

<details>
  <summary>Example</summary>

```yaml
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
      runnerIndexes:
        description: "Runner indexes"
        required: false
        default: "[\"1\"]"

jobs:
  test-action:
    name: Tusk Test Runner
    runs-on: ubuntu-latest

    strategy:
      matrix:
        runnerIndex: ${{ fromJson(github.event.inputs.runnerIndexes) }}

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
        uses: Use-Tusk/test-runner@v1
        with:
          runId: ${{ github.event.inputs.runId }}
          tuskUrl: ${{ github.event.inputs.tuskUrl }}
          commitSha: ${{ github.event.inputs.commitSha }}
          authToken: ${{ secrets.TUSK_AUTH_TOKEN }}
          testFramework: "pytest"
          testFileRegex: "^tests/.*(test_.*|.*_test).py$"
          lintScript: black {{ file }}
          testScript: pytest {{ file }}
          runnerIndex: ${{ matrix.runnerIndex }}
```

</details>

You will also need to set the number of sandboxes to use in the Tusk app. Tusk will use that to determine the indexes to set during workflow dispatch.

## Contact

Need help? Drop us an email at support@usetusk.ai.

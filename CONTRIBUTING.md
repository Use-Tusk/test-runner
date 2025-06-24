# Contributing Guide

## Setup

- Install node version - `nvm install`
- Set node version - `nvm use`
- Install dependencies - `npm install`

## Build

- Make your desired changes.
- Run `npm run bundle` to transpile code and dependencies.
- Push your changes.

## Release

Use the helper script `script/release` to tag and push a new release. For now we only increment `v1.0.x`. Tusk server checks for a step with `Use-Tusk/test-runner@v1` during validation.

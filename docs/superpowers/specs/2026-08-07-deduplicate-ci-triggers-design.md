# Deduplicate CI Triggers

## Problem

The CI workflow currently runs on every `push` and every `pull_request`. A push to an open pull-request branch therefore starts two identical six-job matrices for the same commit. The duplicated check runs compete for hosted runners, clutter the pull-request check rollup, and leave cancelled or failed duplicates when GitHub Actions cannot provision every job.

## Design

Run the full matrix for pull requests, and run it for pushes to `main` only. A feature-branch commit then produces one pull-request matrix; the merged commit still receives post-merge validation on `main`. Keep the existing operating-system and Node.js matrix, `fail-fast: false`, and every test and native-binding smoke step unchanged.

## Verification

Extend the release contract test to require an unfiltered `pull_request` trigger and a `push` trigger restricted to `main`. Verify the test fails against the current broad push trigger, passes after the workflow change, and then run the complete project check.

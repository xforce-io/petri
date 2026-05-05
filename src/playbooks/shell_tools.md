# Shell Tools

You have the ability to execute shell commands in the project workspace.

## Running Commands
- Execute shell commands and capture their output
- Commands run in the project root directory by default

## Guidelines
- Prefer non-destructive commands when possible
- Check command exit codes for success/failure
- Capture both stdout and stderr
- Do not run commands that require interactive input
- Avoid commands that modify global system state

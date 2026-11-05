# Reason

T3 Code runs [Reason](https://reasonmachines.com) as an agent through the Reason CLI. Reason's agent
runs in Reason's cloud; its commands run on this computer, on a Reason cloud computer, or on a
machine you share. Each T3 Code thread is a Reason Session, so it also shows in the Reason app.

Reason is on by default. New threads start on Reason when it is installed and signed in.

## Set Up Reason

1. Install the Reason CLI on the machine running the T3 Code server:
   `curl -fsSL https://reasonmachines.com/install.sh | bash`, or
   `npm install -g @reason-machines/cli` with Node.js 18 or newer.
2. Run `reason login` once in a terminal. Without a browser, create an API key at
   [reasonmachines.com](https://reasonmachines.com/customize?tab=api) and set it as
   `REASON_API_KEY` in the Reason provider's environment variables.
3. Open **Settings → Providers** and refresh Reason. It shows your account and Workspace.

If `reason` is not on the server's `PATH`, set its **Binary path**; `command -v reason` prints it.
The **Workspace** setting picks one of your Workspaces; leave it empty for the one
`reason whoami` shows.

## Where Work Runs

**Runs on** decides where the agent's commands run:

- **This computer** runs in the project folder, so edits land in your files. Reason runs only in
  folders inside your home folder; other projects fail with "Run from a folder in your home
  folder". Use **Reason cloud** for those.
- **Reason cloud** runs on a Reason cloud computer, using the project's GitHub or GitLab repository.
- **A shared machine** sends work to the machine named in **Machine**, shared with `reason serve`.

Add another Reason provider instance to keep, for example, a local and a cloud setup side by side.

## Models

The model picker lists what your Workspace can run: Reason's included model and the models of
accounts you connected in Reason, such as a ChatGPT or Claude subscription, grouped by account.
**Auto** uses your Workspace's default. Models with adjustable effort show a **Reasoning** setting
with the levels Reason offers for that model.

## Permissions and Limits

Reason uses its own tools and never asks T3 Code for approval, so it offers only **Full access**.
A Reason question ends the turn; your next message answers it. **Stop** ends the turn, and your next
message resumes the stopped work with it. Reason does not use T3 Code's MCP tools, and `/compact` is
an ordinary message.

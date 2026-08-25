# BrixHub — Pterodactyl

## Startup command

Configure the Pterodactyl server startup command to:

```text
sh /home/container/brixhub/pterodactyl/start.sh
```

If the repository is not present yet, use this one-time command as the startup command instead:

```text
mkdir -p /home/container/brixhub && git clone https://github.com/Noxo123/brixhub.git /home/container/brixhub && sh /home/container/brixhub/pterodactyl/start.sh
```

## Environment variables

Create this Pterodactyl variable:

- `BRIXHUB_API_KEY` — your BrixHub API key

Do not put the API key in GitHub or in frontend code.

## Port

Allocate one Pterodactyl port and set:

- `PORT` = allocated port

Next.js will listen on the Pterodactyl allocation through the normal `PORT` environment variable.

## Automatic updates

Every server start pulls `origin/main`, installs dependencies, builds the Next.js application, then launches it with `npm start`.

# Railway Multilogin Lights Cron

This package starts a Multilogin profile, connects Playwright over CDP, searches Nextdoor for `lights`, and writes results to `unfiltered_lights`.

## Railway variables

Required:

- `PROFILE_ID=54f84179-2188-49a4-82ae-adc43f82ce20`
- `MULTILOGIN_FOLDER_ID=default` (change if the profile is in another folder)
- `MULTILOGIN_EMAIL`
- `MULTILOGIN_PASSWORD` (or `MULTILOGIN_PASSWORD_MD5`)
- `DATABASE_URL`

Optional:

- `MULTILOGIN_TOKEN`: uses a manually copied short-lived token instead of signing in. It will expire, so email/password is preferred for cron runs.
- `MULTILOGIN_HEADLESS=true`
- `LIGHTS_MAX_POSTS=50`
- `LIGHTS_FALLBACK_STATE=TX`

## Deploy

1. Unzip and push the folder to GitHub.
2. Create a Railway service from that repository.
3. Add the variables above.
4. Railway will build the included Dockerfile.
5. Test one manual deployment before enabling a cron schedule.

## Expected startup logs

```
⏳ Waiting for the Multilogin launcher API...
✅ Multilogin launcher is ready
🔐 Signing in to Multilogin for a fresh short-lived token...
✅ Fresh Multilogin token received.
🚀 Starting Multilogin profile ...
✅ Browser debugging port: ...
▶️ Launching the lights scraper...
```

## Important first-deployment note

The Dockerfile extends Multilogin's official launcher image. The entrypoint includes diagnostics because the internal launcher executable path is controlled by that image and may change. If the deployment reports that it cannot locate the launcher, keep the full Railway build/runtime log; the package will show what stage failed.

The token printed or stored by Multilogin is a secret. Do not commit `.env`, paste tokens into source code, or print the full token in logs.

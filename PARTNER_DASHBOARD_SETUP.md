# Shopify Partner Dashboard Configuration Guide

## Overview
This guide helps you configure your Shopify Partner Dashboard correctly to avoid the "There's no page at this address" error.

## Quick Setup

### 1. Get Your Current ngrok URL
First, ensure your ngrok tunnel is running and note the URL (e.g., `https://d6a48525369e.ngrok-free.app`)

### 2. Partner Dashboard Configuration

Log into your [Shopify Partner Dashboard](https://partners.shopify.com) and navigate to your app settings.

### 3. Required URLs Configuration

#### App URL
This is the main entry point for your app when accessed from Shopify admin:
```
https://YOUR_NGROK_URL.ngrok-free.app/app
```

**Important:** The `/app` at the end is REQUIRED!

#### Allowed Redirection URLs
Add ALL of these URLs to the allowed redirection URLs list:
```
https://YOUR_NGROK_URL.ngrok-free.app/auth/callback
https://YOUR_NGROK_URL.ngrok-free.app/auth/success
https://YOUR_NGROK_URL.ngrok-free.app/app
https://YOUR_NGROK_URL.ngrok-free.app/
https://YOUR_NGROK_URL.ngrok-free.app/exitiframe
```

## Common Issues and Solutions

### "There's no page at this address" Error

**Cause:** Usually means the App URL in Partner Dashboard doesn't match your server routes.

**Solution:**
1. Check that your App URL ends with `/app`
2. Verify all redirect URLs are added exactly as shown above
3. Ensure your ngrok URL hasn't changed

### OAuth Errors

**Cause:** Redirect URL mismatch or missing URLs in whitelist.

**Solution:**
1. Check for trailing slashes (don't add them)
2. Ensure protocol matches (https vs http)
3. Add all 5 redirect URLs listed above

### App Not Loading in Shopify Admin

**Cause:** Session token issues or incorrect embedded app configuration.

**Solution:**
1. Clear browser cache and cookies
2. Reinstall the app
3. Check server logs for specific errors

## Debug Tools

Access these URLs to diagnose issues:

1. **Configuration Check:** `https://YOUR_NGROK_URL.ngrok-free.app/debug/partner-config`
2. **General Debug:** `https://YOUR_NGROK_URL.ngrok-free.app/debug`
3. **Installation Page:** `https://YOUR_NGROK_URL.ngrok-free.app/install`

## Testing Your Configuration

1. After updating Partner Dashboard settings, wait 1-2 minutes for changes to propagate
2. Try installing the app on a development store
3. Check server logs for any errors during the OAuth flow
4. If you see the 404 fallback page, it will show which route Shopify tried to access

## Environment Variables

Ensure your `.env` or `.env.local` file has:
```
SHOPIFY_APP_URL=https://YOUR_NGROK_URL.ngrok-free.app
SHOPIFY_API_KEY=your_api_key_here
SHOPIFY_API_SECRET=your_api_secret_here
```

## Need Help?

If you continue to experience issues:
1. Check the server console logs for detailed error messages
2. Visit `/debug/partner-config` to see your current configuration
3. Ensure ngrok is running and the URL matches everywhere
4. Try the OAuth flow directly: `/auth?shop=yourstore.myshopify.com`
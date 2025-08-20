# Security Guide for Shopify WhatsApp App

## 🔒 Environment Variables & Secrets Management

### Setup Instructions

1. **Copy the example environment file:**
   ```bash
   cp .env.example .env
   ```

2. **Fill in your actual credentials in the .env file:**
   ```bash
   # Get these from your Shopify Partner Dashboard
   SHOPIFY_API_KEY=your_actual_api_key
   SHOPIFY_API_SECRET=your_actual_api_secret
   
   # Get these from your Twilio Console
   TWILIO_ACCOUNT_SID=your_actual_account_sid
   TWILIO_AUTH_TOKEN=your_actual_auth_token
   TWILIO_WHATSAPP_NUMBER=whatsapp:+your_actual_number
   ```

3. **Configure your app URLs:**
   ```bash
   SHOPIFY_APP_URL=https://your-ngrok-url.ngrok-free.app
   SHOPIFY_WEBHOOK_URL=https://your-ngrok-url.ngrok-free.app/webhooks
   ```

### ⚠️ Security Best Practices

#### Environment Variables
- **NEVER commit `.env` files** - They're automatically ignored by git
- **Use different credentials** for development, staging, and production
- **Rotate credentials regularly** - especially if they may have been exposed
- **Use strong, random values** for session secrets and JWT tokens

#### File Structure
```
.env              # Your actual secrets (git ignored)
.env.example      # Template file (safe to commit)
.env.production   # Production secrets (never commit)
.env.staging      # Staging secrets (never commit)
```

#### Credential Sources
- **Shopify API Keys**: [Partner Dashboard](https://partners.shopify.com/)
- **Twilio Credentials**: [Twilio Console](https://console.twilio.com/)
- **ngrok URL**: Run `ngrok http 3000` and copy the HTTPS URL

### 🚨 If Credentials Are Exposed

If you accidentally commit credentials or they become exposed:

1. **Immediately regenerate all credentials:**
   - Generate new Shopify API keys
   - Generate new Twilio auth tokens
   - Create new session secrets

2. **Update your `.env` file** with the new credentials

3. **Remove the exposed credentials** from git history (contact support if needed)

4. **Monitor your accounts** for any unauthorized usage

### 🔐 Additional Security Measures

#### Webhook Security
- ✅ **HMAC signature verification** - All Shopify webhooks are now verified
- ✅ **HTTPS enforcement** - Webhook URLs must use HTTPS
- ⚠️ **Input validation** - Add validation for webhook payload data

**Webhook Security Implementation:**
- All routes under `/webhooks/*` (except WhatsApp) require valid HMAC signatures
- Invalid signatures are rejected with 401 Unauthorized
- Webhook secret is stored securely in environment variables

**How it works:**
1. Shopify sends webhook with `X-Shopify-Hmac-Sha256` header
2. Our app calculates HMAC using the webhook secret
3. If signatures match, webhook is processed
4. If signatures don't match, request is rejected

**To get your webhook secret:**
1. Go to your Shopify Partner Dashboard
2. Navigate to your app → Webhooks
3. Copy the "Webhook Secret" value
4. Add it to your `.env` file as `SHOPIFY_WEBHOOK_SECRET`

#### Input Validation Security
- ✅ **Express-validator middleware** - All user inputs are validated
- ✅ **Phone number validation** - Uses international phone number library
- ✅ **Shop domain validation** - Prevents SSRF attacks
- ✅ **Data sanitization** - Removes harmful characters from messages
- ✅ **XSS protection** - HTML output is properly escaped

**Input Validation Implementation:**
- All webhook payloads are validated and sanitized automatically
- Phone numbers are validated using libphonenumber-js
- Shop domains must match Shopify format (.myshopify.com)
- Message content is sanitized to prevent injection attacks
- Email addresses are validated using industry-standard patterns

**Validation Rules:**
- **Phone Numbers**: Must be 10-15 digits, international format
- **Shop Domains**: Must match `[name].myshopify.com` pattern
- **Email Addresses**: Must pass RFC-compliant validation
- **Currency**: Must be from approved list (USD, CAD, EUR, GBP, SAR, AED)
- **Message Content**: Limited to 1000 characters, harmful chars removed

**Protected Against:**
- SQL injection attacks (parameterized queries + input validation)
- Cross-site scripting (XSS) attacks (HTML escaping)
- Server-side request forgery (SSRF) attacks (URL validation)
- Data corruption from malformed inputs
- Phone number spoofing (proper validation)

#### Database Security
- ✅ **Parameterized queries** - All database operations use safe queries
- Regularly backup your database
- Encrypt sensitive customer data

#### API Security
- Implement rate limiting
- Add request validation middleware
- Log security events for monitoring

### 📋 Security Checklist

Before deploying to production:

- [ ] All credentials are in environment variables (not hardcoded)
- [ ] `.env` file is git-ignored
- [ ] Production uses different credentials than development
- [ ] Webhook HMAC verification is implemented
- [ ] HTTPS is enforced for all endpoints
- [ ] Rate limiting is configured
- [ ] Database backups are automated
- [ ] Monitoring and alerting are set up

### 🆘 Emergency Contacts

If you suspect a security breach:
- **Shopify**: [Security Report](https://www.shopify.com/security/report)
- **Twilio**: [Security Center](https://www.twilio.com/security)

### 📖 Additional Resources

- [Shopify App Security](https://shopify.dev/apps/auth/oauth/create-an-app)
- [Twilio Security Best Practices](https://www.twilio.com/docs/usage/security)
- [Node.js Security Checklist](https://nodejs.org/en/docs/guides/security/)

---

**Remember: Security is an ongoing process, not a one-time setup!**
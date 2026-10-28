# SplitYourShift লাইভ করার ধাপ

পিসিতে কিছু ইনস্টল করতে হবে না। সব কাজ ব্রাউজারে: **Supabase** আর **GitHub**-এ।
মোট সময় লাগবে প্রায় ২০–৩০ মিনিট। একবারই করতে হবে।

---

## ধাপ ১: Supabase প্রজেক্ট খুলুন (ডাটাবেজ)

1. https://supabase.com এ যান → **Start your project** → GitHub দিয়ে লগইন করুন।
2. **New project** চাপুন:
   - **Name:** `splityourshift`
   - **Database Password:** একটা শক্ত পাসওয়ার্ড দিন এবং **কোথাও লিখে রাখুন** (ধাপ ৩-এ লাগবে)।
   - **Region:** `East US (North Virginia)` (আপনার কাস্টমার আমেরিকায়)
   - **Create new project** চাপুন। ১–২ মিনিট অপেক্ষা করুন।
3. প্রজেক্ট খুললে বাম দিকে ⚙️ **Project Settings** এ যান:
   - **General** → **Project ID** কপি করুন (যেমন `abcdxyzqwerty`)।
   - **API Keys** (বা **Data API**) → **Project URL** আর **anon public** key কপি করুন।

## ধাপ ২: Supabase-এ ওয়েবসাইটের ঠিকানা বসান

**Authentication → URL Configuration**:
- **Site URL:** `https://dibyenducse.github.io/splityourshift/`
- **Redirect URLs** → **Add URL:** `https://dibyenducse.github.io/splityourshift/**`

এটা না করলে ইনভাইট আর পাসওয়ার্ড রিসেটের লিংক কাজ করবে না।

## ধাপ ৩: GitHub-এ চাবিগুলো বসান

রিপোতে যান: https://github.com/dibyenducse/splityourshift → **Settings** → **Secrets and variables** → **Actions**।

**Variables** ট্যাব → **New repository variable** (৩টা):

| Name | Value |
|---|---|
| `VITE_SUPABASE_URL` | ধাপ ১-এর Project URL |
| `VITE_SUPABASE_ANON_KEY` | ধাপ ১-এর anon public key |
| `SUPABASE_PROJECT_REF` | ধাপ ১-এর Project ID |

**Secrets** ট্যাব → **New repository secret** (২টা):

| Name | Value |
|---|---|
| `SUPABASE_DB_PASSWORD` | ধাপ ১-এ লিখে রাখা ডাটাবেজ পাসওয়ার্ড |
| `SUPABASE_ACCESS_TOKEN` | https://supabase.com/dashboard/account/tokens → **Generate new token** → কপি |

⚠️ এই দুটো গোপন। কাউকে দেবেন না, চ্যাটেও না। Secrets-এ রাখলে GitHub এগুলো লুকিয়ে রাখে।

## ধাপ ৪: ডাটাবেজ তৈরি করুন

GitHub রিপো → **Actions** ট্যাব → বাম দিকে **Set up database** → **Run workflow** → **Run workflow**।
২–৩ মিনিটে সবুজ ✓ হবে। এটা ডাটাবেজের সব টেবিল, নিরাপত্তার নিয়ম আর দুইটা ফাংশন (ইনভাইট পাঠানো, ফোন দিয়ে লগইন) বানিয়ে দেয়।

> লাল ✗ হলে ক্লিক করে এরর দেখুন। সাধারণত কোনো secret বা variable-এর নাম ভুল হলে এমন হয়।
>
> বিকল্প উপায়: Supabase → **SQL Editor** → `supabase/migrations/20261027000000_init.sql` ফাইলের পুরো লেখা পেস্ট করে **Run**। (তবে ফাংশন দুটো এভাবে যায় না, তাই Actions-ই সহজ।)

## ধাপ ৫: GitHub Pages চালু করুন (ওয়েবসাইট লাইভ)

1. রিপো → **Settings** → **Pages** → **Source:** `GitHub Actions` বেছে নিন।
2. **Actions** ট্যাব → **Deploy site** → **Run workflow**।
3. সবুজ ✓ হলে সাইট লাইভ: **https://dibyenducse.github.io/splityourshift/**

এরপর থেকে কোড বদলালে (main-এ push হলে) সাইট নিজে নিজে আপডেট হবে।

## ধাপ ৬: ইমেইল পাঠানোর ব্যবস্থা (জরুরি)

Supabase-এর নিজের ইমেইল সার্ভিস শুধু টেস্টের জন্য: ঘণ্টায় মাত্র কয়েকটা ইমেইল যায়, আর শুধু আপনার টিমের ঠিকানায়।
ওয়ার্কারদের কাছে ইনভাইট যেতে হলে নিজের SMTP লাগবে। **Resend** ফ্রি (মাসে ৩,০০০ ইমেইল):

1. https://resend.com এ অ্যাকাউন্ট খুলুন → **API Keys** → **Create API Key** → কপি।
2. (ভালো হয় নিজের ডোমেইন যোগ করলে: Resend → **Domains** → Add, তারপর DNS রেকর্ড বসান। Hostinger-এর ডোমেইন থাকলে hPanel → DNS-এ বসাবেন।)
3. Supabase → **Authentication → Emails → SMTP Settings** → **Enable custom SMTP**:
   - Host: `smtp.resend.com` · Port: `465` · Username: `resend` · Password: Resend API key
   - Sender email: `no-reply@আপনার-ডোমেইন.com` · Sender name: `SplitYourShift`
4. (ইচ্ছা হলে) **Authentication → Emails → Templates** → **Invite user** ইমেইলের লেখা বদলাতে পারেন।

## ধাপ ৭: নিজেকে অ্যাডমিন বানান

1. সাইটে গিয়ে **Sign up** দিয়ে আপনার ইমেইলে একটা অ্যাকাউন্ট খুলুন (ইমেইল কনফার্ম করুন)।
   শুধু অ্যাডমিন হতে চাইলে শিফট সেটআপের ধাপে "Log out" চেপে বেরিয়ে আসতে পারেন।
2. Supabase → **SQL Editor** → নিচের লাইন পেস্ট করুন (ইমেইল বদলে) → **Run**:

```sql
insert into public.platform_admins (user_id)
select id from auth.users where email = 'আপনার@ইমেইল.com';
```

3. আবার লগইন করলে অ্যাডমিন প্যানেল দেখবেন: ভিজিটর, সাইন-আপ, সব অ্যাকাউন্ট।

> অ্যাডমিন অ্যাকাউন্ট আর হোটেল মালিকের অ্যাকাউন্ট আলাদা ইমেইলে রাখুন।

## ধাপ ৮: শিফট রিমাইন্ডার (ক্লক ইন / ক্লক আউট নোটিফিকেশন)

সার্ভারের দিকে কিছু করতে হবে না: **Set up database** চালালেই রিমাইন্ডার চালু হয় (প্রতি ৫ মিনিটে চেক করে)।

প্রত্যেক ওয়ার্কারকে তার ফোনে একবার চালু করতে হবে:
- **Android (Chrome):** সাইটে লগইন → Time clock → **Turn on shift reminders** → Allow।
- **iPhone (iOS 16.4+):** Safari-তে সাইট খুলুন → Share বাটন → **Add to Home Screen** → হোম স্ক্রিন থেকে SplitYourShift খুলে লগইন → **Turn on shift reminders** → Allow।

মালিকের প্রোফাইলে (নামের বাটন) **Time zone** ঠিক আছে কিনা দেখে নিন, নইলে রিমাইন্ডার ভুল সময়ে যাবে।

---

## কোথায় কী থাকে

| জিনিস | কোথায় |
|---|---|
| ওয়েবসাইটের ফাইল | GitHub Pages |
| সব ডাটা (মালিক, ওয়ার্কার, শিডিউল, রিকোয়েস্ট, রেট) | Supabase ডাটাবেজ (আমেরিকার সার্ভার) |
| পাসওয়ার্ড | Supabase Auth, hash করে, কেউ দেখতে পারে না |
| ইমেইল | Resend দিয়ে পাঠানো |

ডাটা দেখতে চাইলে: Supabase → **Table Editor**।
ব্যাকআপ: Supabase ফ্রি প্ল্যানে প্রতিদিন ব্যাকআপ হয় (৭ দিন রাখে)। Pro প্ল্যানে বেশি।

## খরচ

| সার্ভিস | ফ্রি প্ল্যানে কতটুকু |
|---|---|
| GitHub Pages | ফ্রি (পাবলিক রিপো) |
| Supabase | ৫০০ MB ডাটাবেজ, ৫০,০০০ মাসিক ইউজার। ১ সপ্তাহ কেউ ব্যবহার না করলে প্রজেক্ট "pause" হয়; কাস্টমার এলে **Pro ($25/মাস)** নেওয়া উচিত |
| Resend | মাসে ৩,০০০ ইমেইল ফ্রি |

## Hostinger-এ splityourshift.com চালানো

1. **hPanel → Websites → Add website** → `splityourshift.com` → **Empty website / Skip** (WordPress বা Builder নয়)।
2. **hPanel → Security → SSL** → splityourshift.com-এর জন্য ফ্রি SSL **Install** (https চালু না হলে সাইট খুলবে না)।
3. **hPanel → Files → FTP Accounts** → সেখানে লেখা **FTP IP/Hostname**, **FTP username** দেখুন; পাসওয়ার্ড জানা না থাকলে **Change password**।
4. GitHub → Settings → Secrets and variables → Actions:
   - **Secrets**: `FTP_SERVER` (FTP hostname/IP), `FTP_USERNAME`, `FTP_PASSWORD`
   - **Variables**: `SITE_URL` = `https://splityourshift.com/`
5. GitHub → **Actions → Deploy to Hostinger → Run workflow**। সবুজ হলে https://splityourshift.com খুলুন।
   (FTP-তে ঢুকে ফাইল `public_html`-এর বাইরে চলে গেলে Variables-এ `FTP_DIR` = `./` বসিয়ে আবার চালান।)
6. Supabase → **Authentication → URL Configuration**:
   - Site URL: `https://splityourshift.com/`
   - Redirect URLs-এ যোগ করুন: `https://splityourshift.com/**`
7. GitHub → **Actions → Set up database → Run workflow** (ইনভাইট ইমেইলের লিংক নতুন ঠিকানায় যাবে)।
8. **ইমেইল**: hPanel → Emails → `no-reply@splityourshift.com` বানান → Supabase → Authentication → Emails → SMTP:
   Host `smtp.hostinger.com`, Port `465`, Username/ Sender = `no-reply@splityourshift.com`, Password = ওই ইমেইলের পাসওয়ার্ড।

এরপর থেকে কোড বদলালে সাইট নিজে থেকে Hostinger-এ আপডেট হবে।

## নিজের ডোমেইন (ঐচ্ছিক)

Hostinger-এ কেনা ডোমেইন (যেমন `splityourshift.com`) ব্যবহার করতে:
1. রিপো → Settings → Pages → **Custom domain** → ডোমেইন লিখে Save।
2. Hostinger hPanel → **DNS** → `CNAME` রেকর্ড: `www` → `dibyenducse.github.io` (মূল ডোমেইনের জন্য GitHub-এর ৪টা `A` রেকর্ড; Pages পেজে নির্দেশনা দেখায়)।
3. Supabase-এর Site URL আর Redirect URL নতুন ডোমেইনে বদলান (ধাপ ২), আর `supabase.yml`-এর `SITE_URL` লাইনও।

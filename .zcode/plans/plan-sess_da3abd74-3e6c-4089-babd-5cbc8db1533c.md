# بازنشانی رمز عبور کاربران توسط ادمین

## Context (چرا و چه چیزی)
کاربر خواسته ادمین بتواند رمز عبور بقیه کاربران را «بازیابی یا تغییر» دهد. رمزها با scrypt به‌صورت **هش یک‌طرفه** ذخیره می‌شوند (`passwordRecord`/`passwordMatches` در `api/server.js:263-273`)، پس خواندن رمز فعلی ممکن نیست — آنچه ساخته می‌شود **بازنشانی**: ادمین رمز جدیدی برای کاربر تنظیم می‌کند (سناریوی واقعی: عضو رمزش را فراموش کرده، باشگاه هیچ زیرساخت پیامکی/ایمیلی ندارد و ادمین راه نجات است). برای پوشش هر دو حالتِ «ادمین خودش رمز انتخاب می‌کند» و «سیستم رمز موقت تولید می‌کند»، یک دکمه تولید رمز تصادفی هم در فرم هست.

## ۱. API — `api/server.js` (یک مسیر جدید، مطابق قراردادهای موجود)

`POST /api/admin/user/password` با بدنه `{ id, password }`، کنار بقیه مسیرهای admin (بعد از `'POST /api/admin/user/admin'` حدود خط 591):
- `if (!requireAdmin(req, res)) return;` — همان گارد همه مسیرهای ادمین
- `readBody` → پیدا کردن کاربر → `404 {error:'no such user'}` (قرارداد موجود)
- **گارد امنیتی:** `if (isAdmin(u)) return json(res, 400, { error: 'cannot reset an admin password' })` — دقیقاً مطابق پیش‌نماند `cannot disable an admin` (server.js:521). این جلوی آن را می‌گیرد که ادمین معمولی با بازنشانی رمز، حساب مالک (env-admin) را تصاحب کند.
- اعتبارسنجی همان register: `password.length < 8 || > 200` → `400 {error:'password must be at least 8 characters'}` (server.js:314)
- `u.password = passwordRecord(body.password)` (هش scrypt موجود) + `u.sv = (u.sv || 0) + 1` — شمارنده نسخه سشن (مکانیزم `logout/all` در server.js:357-363) که همه کوکی‌های نشست فعالِ آن کاربر را باطل می‌کند؛ یعنی عضو از همه دستگاه‌ها بیرون می‌آید و باید با رمز جدید وارد شود
- `saveDb()` و پاسخ `{ ok: true, id: u.id }`

## ۲. فرانت‌اند — `frontend/src/views/Admin.jsx`

در شیت `UserDetail` (خطوط 60-108)، بین دکمه مربی و «ادمین کردن»، فقط برای غیرادمین‌ها (`!u.admin && !u.envAdmin` — همسو با گارد disable):
- دکمه `btn` با آیکون key و برچسب `t('Reset password')` که یک شیت تو در تو با `openSheet` باز می‌کند (الگوی `AccountSheet` در `Login.jsx` و `pickCoach` در همین فایل):
  - عنوان `t('New password for {0}', u.name)`
  - توضیح کوتاه: `t('They will be signed out everywhere and must sign in with the new password.')`
  - دو input با کلاس `input`: «رمز عبور» و «تکرار رمز عبور» (کلیدهای موجود `Password`/`Confirm password` در fa.js)
  - دکمه `btn sm` تولید رمز تصادفی (`crypto.getRandomValues`، الفبای بدون کاراکتر گمراه‌کننده، ۱۰ نویسه) که هر دو فیلد را پر می‌کند
  - دکمه primary ذخیره: اعتبارسنجی سمت کلاینت مثل AccountSheet (خالی نباشد، ≥۸، یکسان بودن دو فیلد — کلیدهای موجود `Password must be at least 8 characters` و `Passwords do not match` با toast) → `api('/api/admin/user/password', { method:'POST', body: JSON.stringify({ id: u.id, password }) })` → toast `t('Password updated')` + بستن شیت داخلی + `onChanged()`. خطا: `.catch(e => toast(e.message))` — همان الگوی بقیه اکشن‌ها.

## ۳. بومی‌سازی — `frontend/src/locales/fa.js`

چهار کلید جدید (کلید = متن انگلیسی، مطابق قرارداد فایل):
- `"Reset password": "بازنشانی رمز عبور"`
- `"New password for {0}": "رمز عبور جدید برای {0}"`
- `"Generate password": "تولید رمز"`
- `"Password updated": "رمز عبور به‌روزرسانی شد"`
- `"They will be signed out everywhere and must sign in with the new password.": "از همهٔ دستگاه‌ها خارج می‌شود و باید با رمز عبور جدید وارد شود."`
توجه: تست `src/lib/i18n.test.js` تطابق placeholder ها ({0}) را چک می‌کند — رشته فارسی باید {0} را نگه دارد.

## Verification
1. `npm test` (شامل تست i18n برای placeholderها) و `npm run build`.
2. `npm run dev` (API + فرانت). چون register ادمین نمی‌سازد، کاربر آزمایشی را ثبت می‌کنم و با توقف موقت API و ست کردن `admin: true` در `DATA/db.json` (مسیر DATA_DIR که scripts/start-api.js ست می‌کند) ادمینش می‌کنم؛ یک کاربر دوم «عضو» می‌ماند.
3. در پنل ادمین (مرورگر، عرض دسکتاپ): UserDetail عضو → «بازنشانی رمز عبور» → تولید رمز → ذخیره → toast موفقیت.
4. جریان واقعی: سشن قبلیِ عضو باید باطل شده باشد (sync بعدی 401 می‌خورد → صفحه ورود) و ورود با رمز جدید باید موفق شود. تلاش برای بازنشانی رمزِ خود ادمین باید خطای `cannot reset an admin password` برگردانداند (دکمه اصلاً برای ادمین‌ها رندر نمی‌شود؛ گارد سرور هم پشت آن است).
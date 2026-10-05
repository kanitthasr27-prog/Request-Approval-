# ระบบอนุมัติการเบิกสินค้าตัวอย่าง

ดู [PRD.md](PRD.md) · [TASKS.md](TASKS.md) (รายการงานและบันทึกการตัดสินใจ)

## รันในเครื่อง

ต้องมี Node.js 22 ขึ้นไป ไม่ต้องตั้งฐานข้อมูล (ใช้ Postgres แบบฝังเก็บที่ `data/pglite`)

```bash
npm install
npm start
```

เปิด http://localhost:3000 — ครั้งแรกระบบสร้างบัญชี `hr` และ `admin` แล้วพิมพ์รหัสผ่านชั่วคราวในคอนโซลครั้งเดียว

ข้อมูลสาธิต (ผู้ขอ/ผู้อนุมัติ/คลัง รหัส `Demo12345`):

```bash
npm run seed-demo
```

ทดสอบอัตโนมัติ: `npm test`

## ขึ้น Vercel + Supabase

1. **Supabase**: ตารางถูกสร้างแล้วในโปรเจกต์ `request-approval` (ไฟล์ [schema.sql](server/schema.sql)) ไปที่ Dashboard → **Connect** → เลือก **Transaction pooler** คัดลอก connection string (ใส่รหัสผ่านฐานข้อมูล ถ้าลืมให้ Reset ที่ Project Settings → Database)
2. **สร้างบัญชี hr/admin ครั้งแรก** (รันในเครื่อง ครั้งเดียว) แล้วจดรหัสที่พิมพ์ออกมา:
   ```bash
   $env:DATABASE_URL = "<connection string>"; npm run bootstrap
   ```
3. **Vercel**: Add New → Project → Import repo `Request-Approval-` → ก่อนกด Deploy ตั้ง Environment Variables:
   - `DATABASE_URL` = connection string จากข้อ 1
   - `CRON_SECRET` = ข้อความสุ่มยาวๆ (Vercel Cron ใช้ยืนยันตัวตนเวลาเรียกตรวจของยืมเลยกำหนดวันละครั้ง)
4. กด Deploy แล้วเปิดลิงก์ที่ได้ ล็อกอินด้วย `hr` / `admin` จากข้อ 2

ติดตั้งลงหน้าจอโฮม: เมนูเบราว์เซอร์ → "เพิ่มลงหน้าจอโฮม" (ต้อง HTTPS ซึ่ง Vercel ให้อยู่แล้ว)

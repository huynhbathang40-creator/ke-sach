# Kệ Sách Kỹ Thuật

Ứng dụng đọc và nghe sách Data Engineering / Software Engineering, đồng bộ giữa MacBook và iPhone qua Supabase.

## Cấu trúc

| File | Vai trò |
| --- | --- |
| `index.html` | Toàn bộ giao diện và logic đọc / nghe / thẻ ghi nhớ |
| `platform.js` | Lớp kết nối Supabase: đăng nhập, lưu dữ liệu, ảnh, AI, TTS, cache âm thanh |
| `sw.js` | Service worker để mở app khi không có mạng |
| `manifest.webmanifest`, `icon-*.png`, `apple-touch-icon.png` | Cài app lên màn hình chính |
| `supabase/functions/ai`, `supabase/functions/tts` | Edge function trên Supabase (bản sao lưu; chạy trên Supabase, không phải Netlify) |
| `netlify.toml` | Cấu hình Netlify: không có bước build, xuất bản thư mục gốc |

## Tự động deploy từ GitHub lên Netlify

1. Vào https://app.netlify.com/projects/ke-sach-ky-thuat → **Project configuration → Build & deploy → Continuous deployment → Link repository**.
2. Chọn GitHub → repo `ke-sach` → nhánh `main`.
3. Build command để trống, Publish directory là `.` (đã có trong `netlify.toml`).

Từ đó, mỗi lần sửa file trên GitHub (kể cả sửa trực tiếp trên web github.com) và commit vào `main`, Netlify sẽ tự cập nhật trang.

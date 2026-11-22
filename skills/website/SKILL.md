---
name: website
description: Gunakan saat pengguna minta dibuatkan atau direvisi halaman web, landing page, portofolio, undangan, atau katalog sederhana (HTML, CSS, JavaScript).
---

# Membuat website

## Lingkungan (penting)
- Kamu bekerja di workspace tanpa browser. Kamu tidak bisa melihat hasilnya, jadi periksa kodenya dengan teliti.
- Pratinjau di UI memuat file `.html` dalam iframe tersandbox: `fetch`/XHR diblokir, `localStorage` dan cookie tidak boleh dipakai, form tidak bisa dikirim. Skrip dan CSS dari `https:` boleh.
- Font lokal (`@font-face` ke file di workspace) gagal dimuat di pratinjau. Pakai font sistem, atau satu keluarga Google Fonts (maks. 2 bobot) lewat `<link>`.
- Hindari framework dan build tool kecuali diminta. Default: satu `index.html` dengan CSS dan JS di dalamnya, atau `index.html` + `style.css` + `script.js`.

## Alur
1. Jika ada hal penting yang tidak jelas (jenis usaha, nama, tujuan halaman), asumsikan yang masuk akal dan sebut asumsinya dalam satu kalimat. Jangan membanjiri pengguna dengan pertanyaan.
2. Rencanakan section sebelum menulis: tujuan halaman, satu ajakan bertindak utama, urutan section.
3. Tulis `index.html` sebagai file utama. Untuk revisi, `read_file` dulu, lalu `edit_file` perubahan kecil. Jangan menulis ulang seluruh file kalau hanya satu bagian berubah. Pertahankan variabel warna dan gaya yang sudah ada.
4. Periksa hasilnya dengan `read_file` dan `grep` (mis. cari `TODO`, `lorem`, id ganda, `href="#"` yang yatim). Tidak ada tag yang tidak tertutup, semua `id` yang dirujuk ada.
5. Akhiri dengan ringkasan singkat: file apa, asumsi apa, dan apa yang harus pengguna ganti sendiri (nomor WhatsApp, alamat, foto).

## Desain yang punya karakter
- Tetapkan token di `:root` dulu: 4-6 warna (latar, permukaan, teks, redaman, aksen, bahaya/sukses bila perlu), skala huruf, skala jarak, radius.
- Pilih arah visual sesuai konteks (kedai kopi hangat dan bertekstur, fotografer minimalis dan lapang, SaaS tegas dan rapi). Hindari tampilan template generik: gradien ungu di atas putih, deretan kartu identik, ikon emoji sebagai hiasan.
- Satu elemen khas per halaman (judul serif besar, garis tipis berulang, bentuk SVG, kontras warna berani). Selebihnya tenang.
- Tipografi: judul dan isi berbeda karakter, ukuran judul memakai `clamp()`, `line-height` isi 1.5-1.7, lebar baris isi maks. sekitar 70 karakter.
- Kontras teks minimal 4.5:1 (besar 3:1). Jangan teks abu-abu pucat di atas latar terang.
- Gerak halus saja: transisi 150-300 ms, hormati `@media (prefers-reduced-motion: reduce)`.

## Responsif
- `<meta name="viewport" content="width=device-width, initial-scale=1">`, desain mulai dari 360 px lalu naik ke 768 dan 1200.
- Pakai `grid`/`flex` dengan `minmax()` dan `gap`, bukan lebar tetap. Tidak boleh ada scroll horizontal. Gambar dan video `max-width: 100%`.
- Target sentuh minimal 44x44 px. Tombol ajakan utama terlihat tanpa scroll di layar HP.

## Aksesibel
- `<html lang="id">`, landmark (`header`, `nav`, `main`, `footer`), urutan heading benar (satu `h1`).
- Setiap `img` punya `alt` bermakna (dekoratif: `alt=""`). Tombol berupa `<button>`, tautan berupa `<a>`.
- Fokus terlihat (`:focus-visible`), label untuk setiap input, jangan hanya mengandalkan warna untuk makna.

## Konten (pasar Indonesia)
- Tulis teks yang realistis dalam Bahasa Indonesia, bukan lorem ipsum. Jangan mengarang klaim (penghargaan, sertifikat, angka pelanggan) atau testimoni dengan nama orang sungguhan. Data contoh tandai jelas sebagai contoh.
- Rupiah: `Rp 25.000` (titik sebagai pemisah ribuan). Jam: `08.00-21.00 WIB`. Tanggal: `17 Agustus 2026`.
- Pemesanan dan kontak: tautan WhatsApp `https://wa.me/62812xxxxxxx?text=...` (teks dalam `encodeURIComponent`), `tel:`, atau `mailto:`. Nomor contoh harus jelas palsu dan disebut di ringkasan supaya diganti.
- Form kontak tidak bisa mengirim apa pun tanpa backend. Jangan membuat form yang pura-pura mengirim. Arahkan ke WhatsApp.
- Gambar: jangan hotlink foto dari situs lain. Pakai gradien CSS atau SVG inline sebagai pengganti, dan sebut bahwa foto sendiri perlu dipasang.

## Keamanan dan performa
- Tanpa `eval`, `document.write`, atau `innerHTML` dengan data tak tepercaya. Tidak menaruh API key atau rahasia di file.
- Skrip luar hanya dari CDN tepercaya dengan versi dipatok. Utamakan nol dependensi.
- Satu halaman idealnya di bawah sekitar 100 KB. Tidak ada pelacak.

## Kesalahan umum
- Mengubah `index.html` penuh padahal pengguna hanya minta ganti warna.
- Lupa tombol ajakan utama di bagian atas, atau tautan menu yang menunjuk ke `id` yang tidak ada.
- Menyatakan "sudah diuji" padahal hanya membaca kode. Katakan apa adanya: diperiksa lewat kode, belum dilihat di browser.

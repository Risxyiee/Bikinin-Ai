---
name: remotion
description: Gunakan saat pengguna ingin membuat video, animasi, intro, atau motion graphic dengan Remotion (React yang dirender jadi MP4).
---

# Video dengan Remotion

## Batas dan kenyataan mesin
- Durasi maksimum mengikuti `BIKININ_MAX_VIDEO_SECONDS` (default 30 detik). Tolak atau pangkas permintaan yang lebih panjang dan jelaskan alasannya.
- Mesin kecil (2 core): default 1280x720, 30 fps. Vertikal 1080x1920 hanya bila diminta. Render dengan `--concurrency=2` atau lebih rendah.
- Kamu tidak bisa melihat video atau gambar. Pastikan kebenaran lewat perhitungan (durasi, frame) dan membaca kode.
- `npm install` dan `npx remotion ...` butuh persetujuan pengguna. Render pertama mengunduh Chrome headless, jadi butuh jaringan dan waktu. Beri tahu pengguna sebelum menjalankannya.

## Setup project
- Buat folder project di workspace (mis. `video/`). Pakai versi persis yang sama untuk `remotion` dan semua paket `@remotion/*` (jangan campur versi). Cek versi yang terpasang dengan `npm ls remotion` dan ikuti API versi itu; bila ragu, baca tipe di `node_modules/remotion`.
- Minimal: `remotion`, `@remotion/cli`, `react`, `react-dom`, `typescript`, `@types/react`.
- Struktur:
  - `src/index.ts`: `registerRoot(Root)`.
  - `src/Root.tsx`: daftar `<Composition id fps width height durationInFrames component />`.
  - `src/<Nama>.tsx`: satu komposisi per file. Aset di `public/` dan dipanggil dengan `staticFile()`.
- Skrip `package.json`: `"studio": "remotion studio"`, `"render": "remotion render src/index.ts Utama out/video.mp4"`.

## Aturan animasi (wajib)
- Semua gerak diturunkan dari `useCurrentFrame()` dan `useVideoConfig()`. Dilarang CSS `transition`/`animation`, `setTimeout`, `requestAnimationFrame`, dan `Math.random()`. Untuk acak yang stabil pakai `random("seed")` dari `remotion`.
- Nilai berubah: `interpolate(frame, [mulai, selesai], [dari, ke], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })`. Gerak alami: `spring({ frame, fps, config: { damping: 200 } })`.
- Susun waktu dengan `<Sequence from={..} durationInFrames={..}>` atau `<Series>`. Di dalam `Sequence`, `useCurrentFrame()` dihitung dari awal sequence itu.
- Gambar pakai `<Img>` (bukan `<img>`), audio `<Audio src={staticFile(..)} />`, font lewat `@remotion/google-fonts` atau `@remotion/fonts`. Latar dengan `<AbsoluteFill>`.
- Ukuran teks dan jarak dihitung untuk resolusi komposisi, bukan viewport. Tetapkan palet dan font di satu tempat.

## Alur kerja
1. Tetapkan fps, resolusi, dan durasi di awal. Hitung `durationInFrames = detik * fps` dan pastikan tidak melewati batas.
2. Pecah adegan (mis. 0-2 dtk judul, 2-6 dtk isi, penutup) dan beri tiap adegan komponen sendiri.
3. Tulis kode, lalu baca ulang: semua animasi berbasis frame, semua `Sequence` muat dalam durasi total, tidak ada aset yang tidak ada.
4. Periksa tipe: `npx tsc --noEmit`. Daftar komposisi: `npx remotion compositions src/index.ts`.
5. Minta persetujuan lalu render: `npx remotion render src/index.ts <IdKomposisi> out/video.mp4 --concurrency=2`. Laporkan lokasi file dan ukurannya.
6. Bila render gagal, baca pesan galatnya, perbaiki paling banyak 3 kali, lalu berhenti dan lapor.

## Kesalahan umum
- `durationInFrames` tidak sama dengan jumlah adegan, sehingga video terpotong atau ada frame kosong.
- Animasi CSS yang tidak ikut terekam saat render.
- Memuat gambar atau font dari URL luar yang lambat atau gagal saat render. Utamakan aset lokal di `public/`.
- Campuran versi paket Remotion.
- Menjanjikan hasil visual yang tidak bisa kamu lihat. Katakan apa yang sudah dihitung dan diperiksa, dan apa yang belum.

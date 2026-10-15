"use strict";

const CACHE_NAME = "kharidyar-v1";

const APP_FILES = [
  "/",
  "/style.css",
  "/script.js",
  "/manifest.json",
  "/icon-192.png",
  "/icon-512.png"
];

// نصب و ذخیره فایل‌های اصلی برنامه
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_FILES))
      .then(() => self.skipWaiting())
  );
});

// فعال‌سازی نسخه جدید و پاک‌کردن کش‌های قدیمی
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) =>
      Promise.all(
        cacheNames
          .filter((name) => name.startsWith("kharidyar-") && name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      )
    ).then(() => self.clients.claim())
  );
});

// پاسخ‌گویی از کش برای فایل‌های اصلی
self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);

  // درخواست‌های غیر GET یا آدرس‌های دیگر را دست‌کاری نکن
  if (request.method !== "GET" || url.origin !== self.location.origin) {
    return;
  }

  // درخواست‌های API باید به سرور برسند تا اطلاعات قدیمی نمایش داده نشود
  if (url.pathname.startsWith("/api/")) {
    return;
  }

  // برای صفحات و فایل‌ها ابتدا شبکه و در صورت قطع اتصال کش
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok && response.type === "basic") {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(async () => {
        const cached = await caches.match(request);
        if (cached) return cached;

        if (request.mode === "navigate") {
          return await caches.match("/");
        }

        return new Response("در حال حاضر اتصال در دسترس نیست.", {
          status: 503,
          headers: { "Content-Type": "text/plain; charset=utf-8" }
        });
      })
  );
});
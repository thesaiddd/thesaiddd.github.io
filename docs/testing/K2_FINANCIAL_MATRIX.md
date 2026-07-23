# K2 EnerjiPro finansal test matrisi

Üretim hesaplama motorunu kullanan deterministik finansal matris şu tek komutla çalıştırılır:

```bash
npm run test:k2-matrix
```

Komut 12 tarife profili × 9 ödeme planı × 4 gerçekleşen ödeme davranışı × 5 GES durumu olmak üzere 2.160 ana senaryoyu; ayrıca PAY, FIN, GES, tarife ve mutabakat hedef kontrollerini çalıştırır. Sonuçlar `test-results/k2-*` dosyalarına CSV, JSON ve Markdown olarak yazılır.

Matris gerçek `calculateOffer`, `calculateRealization`, alacak ledger’ı, ödeme planı ve günlük finansman fonksiyonlarını çağırır. Test içinde ayrı bir finans formülü bulunmaz. Finansal sonuçlar deterministiktir; yalnız ölçüm amacıyla raporlanan çalışma süreleri makine yüküne göre değişebilir.

En az bir ana senaryo veya hedefli kural `FAIL` olduğunda raporlar yine yazılır ve komut non-zero kodla kapanır. `REVIEW`, üretim modelinin istenen ayrımı doğrudan temsil etmediği veya senaryonun sıfır faturadan dolayı uygulanamadığı durumları görünür kılar; tek başına exit kodunu değiştirmez.

132 yönlü müşteri tipi geçişinin gerçek UI kanıtı Playwright ile üretilir:

```bash
npm run test:e2e -- e2e/k2-customer-type-transitions.spec.ts
```

UI geçiş dosyasının matris özetine `PASS` olarak girmesi için E2E komutunu matristen önce çalıştırın.

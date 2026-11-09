#!/usr/bin/env python3
"""Builds faq.html (HR/EN questions with FAQPage structured data).
Edit the FAQ list below, then run:  python3 tools/build_faq_page.py
"""
import html, json, sys
from pathlib import Path
ROOT = Path(__file__).resolve().parent.parent
# (question HR, answer HR, question EN, answer EN)  answers may contain simple HTML links
FAQ = [
 ("Koje je radno vrijeme?", "Otvoreni smo svaki dan od 08:00 do 24:00, cijelu godinu. Kuhinja radi od 08:00 do 22:00. Zatvoreni smo samo 25. prosinca.",
  "What are your opening hours?", "We are open every day from 08:00 to midnight, all year round. The kitchen is open from 08:00 to 22:00. We are closed only on 25 December."),
 ("Gdje se nalazite?", "Ulica Vladimira Gortana 32, 51550 Mali Lošinj, blizu luke. <a href=\"https://maps.google.com/?q=Deveron+Gastro+Pub+Mali+Losinj\">Otvori u Google Maps</a>.",
  "Where are you?", "Ulica Vladimira Gortana 32, 51550 Mali Lošinj, near the harbour. <a href=\"https://maps.google.com/?q=Deveron+Gastro+Pub+Mali+Losinj\">Open in Google Maps</a>."),
 ("Kako mogu rezervirati stol?", "Na <a href=\"/\">deveronpub.com</a> pritisnite <b>Rezerviraj</b> ili nazovite <a href=\"tel:+38551231234\">+385 51 231 234</a>. Za više od 12 osoba molimo nazovite nas.",
  "How do I book a table?", "Tap <b>Book</b> on <a href=\"/\">deveronpub.com</a> or call <a href=\"tel:+38551231234\">+385 51 231 234</a>. For more than 12 guests, please call us."),
 ("Imate li terasu?", "Da. Pri rezervaciji možete odabrati terasu ili unutrašnjost restorana.",
  "Do you have a terrace?", "Yes. When booking you can choose the terrace or a table inside."),
 ("Gdje mogu parkirati?", "Preporučujemo parkirališta Nova Obala, Lidl i Dvorana, izvan centra, oko 5 minuta hoda do restorana.",
  "Where can I park?", "We recommend the Nova Obala, Lidl and Dvorana car parks, outside the centre, about a 5-minute walk from the restaurant."),
 ("Imate li bezglutenska jela?", "Da: pizzu na posebnoj bezglutenskoj bazi i bezglutenske tagliatelle s umakom po želji. Recite konobaru da trebate bez glutena.",
  "Do you have gluten-free food?", "Yes: pizza on a special gluten-free base and gluten-free tagliatelle with a sauce of your choice. Please tell your waiter."),
 ("Kako znam koji alergeni su u jelu?", "Uz svako jelo na <a href=\"/jelovnik.html\">jelovniku</a> i u <a href=\"/#menu\">interaktivnom meniju</a> označeni su alergeni (14 alergena prema EU propisima). Ako imate alergiju, uvijek recite konobaru.",
  "How do I know which allergens a dish contains?", "Every dish on the <a href=\"/jelovnik.html\">menu</a> and in the <a href=\"/#menu\">interactive menu</a> lists its allergens (the 14 EU allergens). If you have an allergy, always tell your waiter."),
 ("Služite li doručak?", "Da, doručak služimo od 08:00. Pogledajte <a href=\"/jelovnik.html\">jelovnik</a>.",
  "Do you serve breakfast?", "Yes, breakfast is served from 08:00. See the <a href=\"/jelovnik.html\">menu</a>."),
 ("Koja su vaša jela po kojima ste poznati?", "Ravioli s kapicama i kozicama u umaku od rakova i kavijara, ravioli s tartufima, lošinjski rižot od sipe, dalmatinska pašticada s njokima, riblja plata za dvoje, buzara i ražnjić Deveron. Gault&amp;Millau Croatia nas je ocijenio s 12,5/20.",
  "What are your signature dishes?", "Ravioli with scallops and prawns in crab and caviar sauce, truffle ravioli, Lošinj cuttlefish risotto, Dalmatian pašticada with gnocchi, fish platter for two, buzara and ražnjić Deveron. Gault&amp;Millau Croatia rates us 12.5/20."),
 ("Mogu li platiti karticom?", "Da, račun možete platiti karticom ili gotovinom. Cijene su u eurima s uključenim PDV-om.",
  "Can I pay by card?", "Yes, you can pay by card or in cash. Prices are in euros, VAT included."),
 ("Mogu li naručiti mobitelom za stolom?", "Da. Skenirajte QR kod na stolu, složite narudžbu i pošaljite je konobaru. Istim ekranom možete pozvati konobara ili zatražiti račun.",
  "Can I order from my phone at the table?", "Yes. Scan the QR code on your table, build your order and send it to the waiter. From the same screen you can call the waiter or ask for the bill."),
 ("Je li meni dostupan na mom jeziku?", "Interaktivni meni na <a href=\"/\">deveronpub.com</a> dostupan je na 16 jezika, a AI asistent odgovara na pitanja o jelima.",
  "Is the menu available in my language?", "The interactive menu on <a href=\"/\">deveronpub.com</a> is available in 16 languages, and an AI assistant answers questions about the dishes."),
 ("Imate li WiFi?", "Da, gosti imaju besplatan WiFi. Naziv mreže i lozinku nađete u izborniku <b>Info</b> na <a href=\"/\">deveronpub.com</a>.",
  "Do you have WiFi?", "Yes, free WiFi for guests. The network name and password are under <b>Info</b> on <a href=\"/\">deveronpub.com</a>."),
]
import re
strip = lambda s: re.sub(r'<[^>]+>', '', s).replace('&amp;', '&')
ld = {"@context": "https://schema.org", "@type": "FAQPage", "inLanguage": ["hr", "en"], "mainEntity": []}
for qh, ah, qe, ae in FAQ:
    for q, a, lang in ((qh, ah, 'hr'), (qe, ae, 'en')):
        ld["mainEntity"].append({"@type": "Question", "name": q, "inLanguage": lang, "acceptedAnswer": {"@type": "Answer", "text": strip(a)}})
items = '\n'.join(f'<details><summary><span>{html.escape(qh)}</span><span class="en" lang="en">{html.escape(qe)}</span></summary>'
                  f'<p>{ah}</p><p class="en" lang="en">{ae}</p></details>' for qh, ah, qe, ae in FAQ)
tpl = (ROOT / 'tools' / 'menu_template.html').read_text(encoding='utf-8')
style = tpl[tpl.index('<style>'):tpl.index('</style>')+8]
style = style.replace('</style>', '''details{background:var(--paper);border:1px solid var(--line);border-radius:10px;margin:10px 0;padding:0 16px}
summary{cursor:pointer;padding:14px 0;font-weight:bold;list-style:none;display:flex;flex-direction:column;gap:2px}
summary::-webkit-details-marker{display:none}
summary .en{font-weight:normal}
details[open] summary{border-bottom:1px dotted var(--line)}
details p{margin:10px 0}
</style>''')
page = f'''<!DOCTYPE html>
<html lang="hr">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Česta pitanja · FAQ · Deveron Gastro Pub, Mali Lošinj</title>
<meta name="description" content="Česta pitanja o Deveron Gastro Pubu u Malom Lošinju: radno vrijeme, rezervacije, parking, terasa, bezglutenska jela, alergeni, plaćanje karticom. FAQ in English: opening hours, booking, parking, gluten-free food."/>
<link rel="canonical" href="https://deveronpub.com/faq.html"/>
<link rel="icon" type="image/png" href="favicon.png"/>
<meta name="theme-color" content="#0a1628"/>
{style}
<script type="application/ld+json">{json.dumps(ld, ensure_ascii=False).replace('</', '<\\/')}</script>
</head>
<body>
<div class="wrap">
<header>
  <h1>Česta pitanja · Deveron Gastro Pub</h1>
  <p class="lede">Frequently asked questions · Mali Lošinj</p>
  <a class="cta" href="/">← deveronpub.com</a>
</header>
{items}
<div class="info">
  <p>Niste našli odgovor? Nazovite nas na <a href="tel:+38551231234">+385 51 231 234</a> ili pitajte <a href="/#ai">AI asistenta</a>.</p>
  <p class="en" lang="en">Didn't find your answer? Call <a href="tel:+38551231234">+385 51 231 234</a> or ask the <a href="/#ai">AI assistant</a>.</p>
</div>
<footer>
  <a href="/">deveronpub.com</a> · <a href="/jelovnik.html">Jelovnik / Menu</a> · <a href="/privacy.html">Privatnost</a>
</footer>
</div>
</body>
</html>
'''
(ROOT / 'faq.html').write_text(page, encoding='utf-8')
print('ok', len(FAQ))

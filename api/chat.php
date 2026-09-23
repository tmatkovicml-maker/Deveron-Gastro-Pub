<?php
// Deveron AI chat proxy (GoDaddy / cPanel shared hosting).
//
// The browser sends only the conversation; this script adds the secret API key,
// the model and the restaurant's system prompt, then calls the Claude Messages API.
//
// Setup: create the file deveron-config.php in your hosting HOME folder
// (one level ABOVE public_html, so it can never be downloaded) with:
//
//   <?php return ['anthropic_api_key' => 'sk-ant-...'];
//
// Raw cURL is used instead of the Anthropic PHP SDK because shared hosting
// usually has no Composer; nothing needs to be installed.

declare(strict_types=1);

const MODEL          = 'claude-opus-5';
const MAX_TOKENS     = 2048;
const MAX_TURNS      = 6;     // last N messages sent to the model
const MAX_MSG_CHARS  = 500;   // per message
const RATE_LIMIT     = 20;    // requests ...
const RATE_WINDOW    = 600;   // ... per IP per 10 minutes

const SYSTEM_PROMPT = <<<TXT
Ti si ljubazni AI asistent restorana Deveron Gastro Pub u Malom Lošinju, Hrvatska.
Restoran je poznat po svježoj ribi, plodovima mora, tartufima i mediteranskoj kuhinji. Ocijenjen je s 12,5 kapica u Gault Millau vodiču.
Adresa: Ul. Vladimira Gortana 32, Mali Lošinj. Telefon: +385 51 231 234.
Radno vrijeme: 08:00-24:00, kuhinja 08:00-22:00, od 15.06. do 23.09.
WiFi: mreža deveronpub, lozinka deveronpub2019.
Rezervacije: https://deveron-gastro-pub-1683645478.resos.com/booking
Preporučena vina uz ribu: Malvazija Kozlović, Matuško Grk, Maestoso Sur Lie.
Za pitanja o alergenima uvijek savjetuj gostu da provjeri s osobljem.
Odgovaraj kratko, prijateljski, na jeziku korisnika, u najviše 3 rečenice, običnim tekstom bez Markdowna.
Odgovaraj samo na pitanja vezana uz restoran, hranu, piće i Mali Lošinj.
TXT;

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

function respond(int $status, array $body): void {
    http_response_code($status);
    echo json_encode($body, JSON_UNESCAPED_UNICODE);
    exit;
}

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    respond(405, ['error' => 'Method not allowed']);
}

// --- API key -----------------------------------------------------------------
$apiKey = getenv('ANTHROPIC_API_KEY') ?: '';
$configFile = dirname(__DIR__, 2) . '/deveron-config.php';
if ($apiKey === '' && is_file($configFile)) {
    $config = require $configFile;
    $apiKey = $config['anthropic_api_key'] ?? '';
}
if ($apiKey === '') {
    error_log('Deveron chat: API key not configured (' . $configFile . ')');
    respond(500, ['error' => 'Not configured']);
}

// --- Simple per-IP rate limit (protects the API bill) -------------------------
$ip = $_SERVER['REMOTE_ADDR'] ?? 'unknown';
$rlFile = sys_get_temp_dir() . '/deveron_rl_' . md5($ip);
$now = time();
$hits = [];
if (is_file($rlFile)) {
    $hits = json_decode((string) file_get_contents($rlFile), true) ?: [];
    $hits = array_values(array_filter($hits, fn($t) => $t > $now - RATE_WINDOW));
}
if (count($hits) >= RATE_LIMIT) {
    respond(429, ['error' => 'Too many requests']);
}
$hits[] = $now;
@file_put_contents($rlFile, json_encode($hits), LOCK_EX);

// --- Validate input ------------------------------------------------------------
$input = json_decode((string) file_get_contents('php://input'), true);
$messages = is_array($input['messages'] ?? null) ? $input['messages'] : [];
$messages = array_slice($messages, -MAX_TURNS);
// History must start with a user turn
while ($messages && ($messages[0]['role'] ?? '') !== 'user') {
    array_shift($messages);
}

$clean = [];
$expected = 'user';
foreach ($messages as $m) {
    $role = $m['role'] ?? '';
    $content = $m['content'] ?? '';
    if ($role !== $expected || !is_string($content) || trim($content) === '') {
        respond(400, ['error' => 'Invalid messages']);
    }
    $clean[] = ['role' => $role, 'content' => mb_substr(trim($content), 0, MAX_MSG_CHARS)];
    $expected = $expected === 'user' ? 'assistant' : 'user';
}
if (!$clean || end($clean)['role'] !== 'user') {
    respond(400, ['error' => 'Invalid messages']);
}

// --- Call the Claude Messages API ------------------------------------------------
$payload = [
    'model'         => MODEL,
    'max_tokens'    => MAX_TOKENS,
    'system'        => SYSTEM_PROMPT,
    'messages'      => $clean,
    'output_config' => ['effort' => 'low'],  // short chat answers, keeps cost and latency down
    'fallbacks'     => 'default',            // re-run a declined request on a fallback model
];

$ch = curl_init('https://api.anthropic.com/v1/messages');
curl_setopt_array($ch, [
    CURLOPT_POST           => true,
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_TIMEOUT        => 60,
    CURLOPT_HTTPHEADER     => [
        'Content-Type: application/json',
        'x-api-key: ' . $apiKey,
        'anthropic-version: 2023-06-01',
        'anthropic-beta: server-side-fallback-2026-07-01',
    ],
    CURLOPT_POSTFIELDS     => json_encode($payload, JSON_UNESCAPED_UNICODE),
]);
$raw = curl_exec($ch);
$status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
$curlError = curl_error($ch);
curl_close($ch);

if ($raw === false || $status !== 200) {
    error_log("Deveron chat: API error $status $curlError " . substr((string) $raw, 0, 500));
    respond(502, ['error' => 'Upstream error']);
}

$data = json_decode($raw, true);
if (($data['stop_reason'] ?? '') === 'refusal') {
    respond(200, ['reply' => 'Nažalost, na to ne mogu odgovoriti. Obratite se osoblju.']);
}

$reply = '';
foreach ($data['content'] ?? [] as $block) {
    if (($block['type'] ?? '') === 'text') {
        $reply .= $block['text'];
    }
}
$reply = trim($reply);
if ($reply === '') {
    respond(502, ['error' => 'Empty reply']);
}

respond(200, ['reply' => $reply]);

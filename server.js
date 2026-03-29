const express = require('express');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const PORT = 30001;
const DOWNLOADS_DIR = path.join(__dirname, 'downloads');

app.use(express.json());
app.use(express.static('public'));

// Ensure downloads directory exists
if (!fs.existsSync(DOWNLOADS_DIR)) {
  fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
}

function isValidYouTubeUrl(url) {
  const pattern = /^(https?:\/\/)?(www\.)?(youtube\.com\/(watch\?.*v=|shorts\/|embed\/)|youtu\.be\/)[\w-]+/;
  return pattern.test(url);
}

app.post('/api/info', (req, res) => {
  const { url } = req.body;

  if (!url || !isValidYouTubeUrl(url)) {
    return res.status(400).json({ error: 'Invalid YouTube URL' });
  }

  const args = ['--dump-json', '--no-playlist', url];
  const proc = spawn('yt-dlp', args);

  let output = '';
  let errOutput = '';

  proc.stdout.on('data', (data) => { output += data.toString(); });
  proc.stderr.on('data', (data) => { errOutput += data.toString(); });

  proc.on('close', (code) => {
    if (code !== 0) {
      return res.status(500).json({ error: 'Failed to fetch video info', details: errOutput });
    }
    try {
      const info = JSON.parse(output);
      res.json({
        title: info.title,
        thumbnail: info.thumbnail,
        duration: info.duration_string || formatDuration(info.duration),
        uploader: info.uploader,
        viewCount: info.view_count,
      });
    } catch {
      res.status(500).json({ error: 'Failed to parse video info' });
    }
  });
});

function formatDuration(seconds) {
  if (!seconds) return 'Unknown';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

app.post('/api/download', (req, res) => {
  const { url, format } = req.body;

  if (!url || !isValidYouTubeUrl(url)) {
    return res.status(400).json({ error: 'Invalid YouTube URL' });
  }

  if (!['mp4', 'mp3'].includes(format)) {
    return res.status(400).json({ error: 'Format must be mp4 or mp3' });
  }

  const sessionId = crypto.randomBytes(8).toString('hex');
  const outputTemplate = path.join(DOWNLOADS_DIR, `${sessionId}.%(ext)s`);

  let args;
  if (format === 'mp4') {
    args = [
      '--no-playlist',
      '-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best',
      '--merge-output-format', 'mp4',
      '-o', outputTemplate,
      url,
    ];
  } else {
    args = [
      '--no-playlist',
      '-x',
      '--audio-format', 'mp3',
      '--audio-quality', '0',
      '-o', outputTemplate,
      url,
    ];
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const sendEvent = (data) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  const proc = spawn('yt-dlp', args);

  proc.stdout.on('data', (data) => {
    const line = data.toString().trim();
    if (line) {
      const progressMatch = line.match(/(\d+\.?\d*)%/);
      if (progressMatch) {
        sendEvent({ type: 'progress', percent: parseFloat(progressMatch[1]), message: line });
      } else {
        sendEvent({ type: 'status', message: line });
      }
    }
  });

  proc.stderr.on('data', (data) => {
    const line = data.toString().trim();
    if (line) sendEvent({ type: 'status', message: line });
  });

  proc.on('close', (code) => {
    if (code !== 0) {
      sendEvent({ type: 'error', message: 'Download failed' });
      res.end();
      return;
    }

    // Find the output file
    const files = fs.readdirSync(DOWNLOADS_DIR).filter(f => f.startsWith(sessionId));
    if (files.length === 0) {
      sendEvent({ type: 'error', message: 'Output file not found' });
      res.end();
      return;
    }

    sendEvent({ type: 'done', fileId: sessionId, filename: files[0] });
    res.end();
  });

  req.on('close', () => {
    proc.kill();
  });
});

app.get('/api/file/:sessionId', (req, res) => {
  const { sessionId } = req.params;

  // Validate sessionId is hex only (safe)
  if (!/^[a-f0-9]{16}$/.test(sessionId)) {
    return res.status(400).json({ error: 'Invalid file ID' });
  }

  const files = fs.readdirSync(DOWNLOADS_DIR).filter(f => f.startsWith(sessionId));
  if (files.length === 0) {
    return res.status(404).json({ error: 'File not found' });
  }

  const filePath = path.join(DOWNLOADS_DIR, files[0]);
  const ext = path.extname(files[0]);
  const mimeType = ext === '.mp3' ? 'audio/mpeg' : 'video/mp4';
  const downloadName = files[0].replace(`${sessionId}.`, 'download.');

  res.setHeader('Content-Disposition', `attachment; filename="${downloadName}"`);
  res.setHeader('Content-Type', mimeType);

  const stream = fs.createReadStream(filePath);
  stream.pipe(res);

  stream.on('close', () => {
    // Clean up after sending
    fs.unlink(filePath, () => {});
  });
});

app.listen(PORT, () => {
  console.log(`YouTube Downloader running at http://localhost:${PORT}`);
});

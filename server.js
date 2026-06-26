const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 8080;

// Serve static files
app.use(express.static(__dirname, {
  index: false,
  dotfiles: 'ignore'
}));

// Redirect root to Arabic payment channels page
app.get('/', (req, res) => {
  res.redirect('/ar/payment-channels');
});

// Serve HTML files without .html extension
app.get('/ar/payment-channels', (req, res) => {
  const filePath = path.join(__dirname, 'ar', 'payment-channels.html');
  if (fs.existsSync(filePath)) {
    res.sendFile(filePath);
  } else {
    res.status(404).send('Page not found');
  }
});

// Catch-all: try to serve .html files
app.get('*', (req, res) => {
  const urlPath = req.path;
  
  // Try exact path
  let filePath = path.join(__dirname, urlPath);
  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    return res.sendFile(filePath);
  }
  
  // Try with .html extension
  filePath = path.join(__dirname, urlPath + '.html');
  if (fs.existsSync(filePath)) {
    return res.sendFile(filePath);
  }
  
  // Try index.html in directory
  filePath = path.join(__dirname, urlPath, 'index.html');
  if (fs.existsSync(filePath)) {
    return res.sendFile(filePath);
  }
  
  res.status(404).send('Page not found');
});

app.listen(PORT, () => {
  console.log(`STC Kuwait server running on port ${PORT}`);
});

import React, { useState } from 'react';
import './App.css';

function App() {
  const [longUrl, setLongUrl] = useState('');
  const [shortUrl, setShortUrl] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    
    if (!longUrl.trim()) {
      setError('Please enter a URL');
      return;
    }

    // Basic URL validation
    try {
      new URL(longUrl);
    } catch {
      setError('Please enter a valid URL (include http:// or https://)');
      return;
    }

    setError('');
    setLoading(true);
    setShortUrl('');

    try {
      const response = await fetch('/url', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ longUrl }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to create short URL');
      }

      // Construct full short URL
      const protocol = window.location.protocol;
      const host = window.location.host;
      const fullShortUrl = `${protocol}//${host}/url/${data.shortUrl}`;
      setShortUrl(fullShortUrl);
    } catch (err) {
      setError(err.message || 'An error occurred. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const copyToClipboard = () => {
    navigator.clipboard.writeText(shortUrl).then(() => {
      alert('Short URL copied to clipboard!');
    }).catch(() => {
      alert('Failed to copy to clipboard');
    });
  };

  return (
    <div className="App">
      <div className="container">
        <header className="header">
          <h1>URL Shortener</h1>
          <p>Create short, memorable links for your URLs</p>
        </header>

        <form onSubmit={handleSubmit} className="form">
          <div className="input-group">
            <input
              type="text"
              value={longUrl}
              onChange={(e) => setLongUrl(e.target.value)}
              placeholder="Enter your long URL (e.g., https://example.com)"
              className="url-input"
              disabled={loading}
            />
            <button 
              type="submit" 
              className="submit-button"
              disabled={loading}
            >
              {loading ? 'Shortening...' : 'Shorten URL'}
            </button>
          </div>
        </form>

        {error && (
          <div className="error-message">
            {error}
          </div>
        )}

        {shortUrl && (
          <div className="result">
            <div className="result-label">Your short URL:</div>
            <div className="result-url-container">
              <a 
                href={shortUrl} 
                target="_blank" 
                rel="noopener noreferrer"
                className="result-url"
              >
                {shortUrl}
              </a>
              <button 
                onClick={copyToClipboard}
                className="copy-button"
              >
                Copy
              </button>
            </div>
            <div className="original-url">
              Original: {longUrl}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default App;

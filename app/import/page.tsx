'use client';

import { useState } from 'react';

export default function ImportPage() {
  const [datasetIds, setDatasetIds] = useState('');
  const [minFollowers, setMinFollowers] = useState(30000);
  const [maxFollowers, setMaxFollowers] = useState(500000);
  const [status, setStatus] = useState('');
  const [importing, setImporting] = useState(false);
  const [results, setResults] = useState<any>(null);

  const handleImport = async () => {
    setImporting(true);
    setStatus('Fetching profiles from Apify datasets...');
    
    try {
      const ids = datasetIds.split('\n').map(id => id.trim()).filter(Boolean);
      
      if (ids.length === 0) {
        alert('Please enter at least one dataset ID');
        setImporting(false);
        return;
      }

      const response = await fetch('/api/import/profiles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          datasetIds: ids,
          minFollowers,
          maxFollowers,
        }),
      });

      const result = await response.json();
      
      if (result.error) {
        setStatus(`Error: ${result.error}`);
      } else {
        setStatus('Import complete!');
        setResults(result);
      }
    } catch (error: any) {
      setStatus(`Error: ${error.message}`);
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100">
      <div className="max-w-4xl mx-auto px-4 py-8">
        <div className="mb-8">
          <h1 className="text-4xl font-bold text-slate-900 mb-2">Import Creators</h1>
          <p className="text-slate-600">Import creator profiles from Apify datasets</p>
        </div>

        <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-6 mb-6">
          <div className="mb-4">
            <label className="block text-sm font-medium text-slate-700 mb-2">
              Dataset IDs (one per line)
            </label>
            <textarea
              value={datasetIds}
              onChange={(e) => setDatasetIds(e.target.value)}
              placeholder="L4w9xSC6nZwzkbQ5j&#10;yehk7ZnU6fKfwxfX6&#10;..."
              className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-violet-500 focus:border-transparent font-mono text-sm"
              rows={10}
            />
          </div>

          <div className="grid grid-cols-2 gap-4 mb-6">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-2">
                Min Followers
              </label>
              <input
                type="number"
                value={minFollowers}
                onChange={(e) => setMinFollowers(parseInt(e.target.value))}
                className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-violet-500 focus:border-transparent"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-2">
                Max Followers
              </label>
              <input
                type="number"
                value={maxFollowers}
                onChange={(e) => setMaxFollowers(parseInt(e.target.value))}
                className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-violet-500 focus:border-transparent"
              />
            </div>
          </div>

          <button
            onClick={handleImport}
            disabled={importing}
            className="w-full px-6 py-3 bg-violet-600 text-white rounded-lg hover:bg-violet-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors font-medium"
          >
            {importing ? 'Importing...' : 'Import Creators'}
          </button>

          {status && (
            <div className="mt-4 p-4 bg-slate-100 rounded-lg">
              <p className="text-sm text-slate-700">{status}</p>
            </div>
          )}

          {results && (
            <div className="mt-4 p-4 bg-green-50 border border-green-200 rounded-lg">
              <h3 className="font-semibold text-green-900 mb-2">Import Results:</h3>
              <ul className="text-sm text-green-800 space-y-1">
                <li>Total profiles fetched: {results.totalFetched}</li>
                <li>Unique profiles: {results.uniqueProfiles}</li>
                <li>Filtered (in range): {results.inRange}</li>
                <li>Saved to database: {results.saved}</li>
                <li>New creators: {results.new}</li>
                <li>Updated creators: {results.updated}</li>
              </ul>
            </div>
          )}
        </div>

        <div className="text-center">
          <a href="/" className="text-violet-600 hover:text-violet-700 font-medium">
            ← Back to Discovery
          </a>
        </div>
      </div>
    </div>
  );
}
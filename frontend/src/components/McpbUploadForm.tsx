import { convertMcpbToMcpConfig } from '../utils/mcpbConfig';
import McpbBatchUpload from './McpbBatchUpload';
import { validateServerKey } from '../../../src/utils/catalog';
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { apiPost, apiGet, apiPut, fetchWithInterceptors } from '@/utils/fetchInterceptor';
import { getApiUrl } from '@/utils/runtime';
import CatalogInput from './CatalogInput';
import ConfirmDialog from '@/components/ui/ConfirmDialog';

interface McpbUploadFormProps {
  catalog?: string;
  onSuccess: (serverConfig: any) => void;
  onCancel: () => void;
}

interface McpbUploadResponse {
  success: boolean;
  data?: {
    manifest: any;
    extractDir: string;
  };
  message?: string;
}

const McpbUploadForm: React.FC<McpbUploadFormProps> = ({ onSuccess, onCancel, catalog: defaultCatalog = '' }) => {
  const { t } = useTranslation();
  const [catalog, setCatalog] = useState(defaultCatalog);
  const [isDragging, setIsDragging] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [batchFiles, setBatchFiles] = useState<File[]>([]);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [showServerForm, setShowServerForm] = useState(false);
  const [manifestData, setManifestData] = useState<any>(null);
  const [extractDir, setExtractDir] = useState<string>('');
  const [showConfirmDialog, setShowConfirmDialog] = useState(false);
  const [pendingServerName, setPendingServerName] = useState<string>('');

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);

    selectFiles(Array.from(e.dataTransfer.files));
  };

  const selectFiles = (files: File[]) => {
    if (files.some((file) => !file.name.endsWith('.mcpb'))) {
      setError(t('mcpb.invalidFileType'));
      return;
    }
    setError(null);
    setBatchFiles(files.length > 1 ? files : []);
    setSelectedFile(files[0] || null);
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    selectFiles(Array.from(e.target.files || []));
  };

  const handleUpload = async () => {
    if (!selectedFile) {
      setError(t('mcpb.noFileSelected'));
      return;
    }

    const identity = validateServerKey('upload', catalog);
    if (!identity.valid) {
      setError(identity.message || t('catalog.label'));
      return;
    }
    setIsUploading(true);
    setError(null);

    try {
      const formData = new FormData();
      formData.append('mcpbFile', selectedFile);
      formData.append('catalog', catalog);

      const response = await fetchWithInterceptors(getApiUrl('/mcpb/upload'), {
        method: 'POST',
        body: formData,
      });

      const result: McpbUploadResponse = await response.json();

      if (!response.ok) {
        throw new Error(result.message || `HTTP error! Status: ${response.status}`);
      }

      if (result.success && result.data) {
        setManifestData(result.data.manifest);
        setExtractDir(result.data.extractDir);
        setShowServerForm(true);
      } else {
        throw new Error(result.message || t('mcpb.uploadFailed'));
      }
    } catch (err) {
      console.error('MCPB upload error:', err);
      setError(err instanceof Error ? err.message : t('mcpb.uploadFailed'));
    } finally {
      setIsUploading(false);
    }
  };

  const handleInstallServer = async (requestedName: string, forceOverride: boolean = false) => {
    setIsUploading(true);
    setError(null);

    try {
      const validation = validateServerKey(requestedName, catalog);
      if (!validation.valid) throw new Error(validation.message);
      const serverName = validation.normalized!;
      // Convert MCPB manifest to MCPHub stdio server configuration
      const serverConfig = convertMcpbToMcpConfig(manifestData, extractDir, serverName);

      // First, check if server exists
      if (!forceOverride) {
        const checkResult = await apiGet('/servers');

        if (checkResult.success) {
          const existingServer = checkResult.data?.find(
            (server: any) => server.name === serverName,
          );

          if (existingServer) {
            // Server exists, show confirmation dialog
            setPendingServerName(serverName);
            setShowConfirmDialog(true);
            setIsUploading(false);
            return;
          }
        }
      }

      // Install or override the server
      let result;
      if (forceOverride) {
        result = await apiPut(`/servers/${encodeURIComponent(serverName)}`, {
          name: serverName,
          config: serverConfig,
        });
      } else {
        result = await apiPost('/servers', {
          name: serverName,
          config: serverConfig,
        });
      }

      if (result.success) {
        onSuccess(serverConfig);
      } else {
        throw new Error(result.message || t('mcpb.installFailed'));
      }
    } catch (err) {
      console.error('MCPB install error:', err);
      setError(err instanceof Error ? err.message : t('mcpb.installFailed'));
      setIsUploading(false);
    }
  };

  const handleConfirmOverride = () => {
    setShowConfirmDialog(false);
    if (pendingServerName) {
      handleInstallServer(pendingServerName, true);
    }
  };

  const handleCancelOverride = () => {
    setShowConfirmDialog(false);
    setPendingServerName('');
    setIsUploading(false);
  };


  if (batchFiles.length > 1) {
    return <McpbBatchUpload files={batchFiles} defaultCatalog={catalog} onSuccess={onSuccess} onCancel={onCancel} />;
  }

  if (showServerForm && manifestData) {
    return (
      <>
        <ConfirmDialog
          isOpen={showConfirmDialog}
          onClose={handleCancelOverride}
          onConfirm={handleConfirmOverride}
          title={t('mcpb.serverExistsTitle')}
          message={t('mcpb.serverExistsConfirm', { serverName: pendingServerName })}
          confirmText={t('mcpb.override')}
          cancelText={t('common.cancel')}
          variant="warning"
        />

        <div
          className={`fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4 ${showConfirmDialog ? 'opacity-50 pointer-events-none' : ''}`}
        >
          <div className="bg-white dark:bg-gray-800 shadow rounded-lg p-6 w-full max-w-3xl max-h-screen overflow-y-auto">
            <div className="flex justify-between items-center mb-6">
              <h2 className="text-xl font-semibold text-gray-900">{t('mcpb.installServer')}</h2>
              <button onClick={onCancel} className="text-gray-500 hover:text-gray-700">
                ✕
              </button>
            </div>

            {error && (
              <div className="mb-4 bg-red-50 dark:bg-red-900/20 border-l-4 border-red-500 p-4 rounded">
                <p className="text-red-700 dark:text-red-300">{error}</p>
              </div>
            )}

            <div className="space-y-6">
              <p className="hub-sub">{t('catalog.label')}: {catalog || t('catalog.public')}</p>
              {/* Extension Info */}
              <div className="bg-gray-50 dark:bg-gray-800 p-4 rounded-lg">
                <h3 className="font-medium text-gray-900 mb-2">{t('mcpb.extensionInfo')}</h3>
                <div className="space-y-2 text-sm">
                  <div>
                    <strong>{t('mcpb.name')}:</strong>{' '}
                    {manifestData.display_name || manifestData.name}
                  </div>
                  <div>
                    <strong>{t('mcpb.version')}:</strong> {manifestData.version}
                  </div>
                  <div>
                    <strong>{t('mcpb.description')}:</strong> {manifestData.description}
                  </div>
                  {manifestData.author && (
                    <div>
                      <strong>{t('mcpb.author')}:</strong> {manifestData.author.name}
                    </div>
                  )}
                  {manifestData.tools && manifestData.tools.length > 0 && (
                    <div>
                      <strong>{t('mcpb.tools')}:</strong>
                      <ul className="list-disc list-inside ml-4">
                        {manifestData.tools.map((tool: any, index: number) => (
                          <li key={index}>
                            {tool.name} - {tool.description}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              </div>

              {/* Server Configuration */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  {t('mcpb.serverName')}
                </label>
                <input
                  type="text"
                  id="serverName"
                  defaultValue={manifestData.name}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 form-input"
                  placeholder={t('mcpb.serverNamePlaceholder')}
                />
              </div>

              {/* Action Buttons */}
              <div className="flex justify-end space-x-4">
                <button onClick={onCancel} disabled={isUploading} className="hub-btn">
                  {t('common.cancel')}
                </button>
                <button
                  onClick={() => {
                    const nameInput = document.getElementById('serverName') as HTMLInputElement;
                    const serverName = nameInput?.value.trim() || manifestData.name;
                    handleInstallServer(serverName);
                  }}
                  disabled={isUploading}
                  className="hub-btn primary"
                >
                  {isUploading ? (
                    <>
                      <svg
                        className="animate-spin h-4 w-4 mr-2"
                        xmlns="http://www.w3.org/2000/svg"
                        fill="none"
                        viewBox="0 0 24 24"
                      >
                        <circle
                          className="opacity-25"
                          cx="12"
                          cy="12"
                          r="10"
                          stroke="currentColor"
                          strokeWidth="4"
                        ></circle>
                        <path
                          className="opacity-75"
                          fill="currentColor"
                          d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                        ></path>
                      </svg>
                      {t('mcpb.installing')}
                    </>
                  ) : (
                    t('mcpb.install')
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      </>
    );
  }

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
      <div className="bg-white dark:bg-gray-800 shadow rounded-lg p-6 w-full max-w-lg">
        <div className="flex justify-between items-center mb-6">
          <h2 className="text-xl font-semibold text-gray-900">{t('mcpb.uploadTitle')}</h2>
          <button onClick={onCancel} className="text-gray-500 hover:text-gray-700">
            ✕
          </button>
        </div>

        {error && (
          <div className="mb-4 bg-red-50 dark:bg-red-900/20 border-l-4 border-red-500 p-4 rounded">
            <p className="text-red-700 dark:text-red-300">{error}</p>
          </div>
        )}

        <CatalogInput value={catalog} onChange={setCatalog} disabled={isUploading} />

        <p className="hub-sub text-sm mb-3">{t('mcpb.batchHelp')}</p>
        {/* File Drop Zone */}
        <div
          className={`relative border-2 border-dashed rounded-lg p-8 text-center transition-colors ${
            isDragging
              ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20'
              : selectedFile
                ? 'border-gray-500 '
                : 'border-gray-300 hover:border-gray-400'
          }`}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          {selectedFile ? (
            <div className="space-y-2">
              <svg
                className="mx-auto h-12 w-12 text-green-200"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
                />
              </svg>
              <p className="text-sm text-gray-900 font-medium">{selectedFile.name}</p>
              <p className="text-xs text-gray-500">
                {(selectedFile.size / 1024 / 1024).toFixed(2)} MB
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              <svg
                className="mx-auto h-12 w-12 text-gray-400"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"
                />
              </svg>
              <div>
                <p className="text-sm text-gray-900">{t('mcpb.dropFileHere')}</p>
                <p className="text-xs text-gray-500">{t('mcpb.orClickToSelect')}</p>
              </div>
            </div>
          )}

          <input
            type="file"
            accept=".mcpb"
            multiple
            onChange={handleFileSelect}
            className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
          />
        </div>

        <div className="mt-6 flex justify-end space-x-4">
          <button onClick={onCancel} disabled={isUploading} className="hub-btn">
            {t('common.cancel')}
          </button>
          <button
            onClick={handleUpload}
            disabled={!selectedFile || isUploading}
            className="hub-btn primary flex items-center"
          >
            {isUploading ? (
              <>
                <svg
                  className="animate-spin h-4 w-4 mr-2"
                  xmlns="http://www.w3.org/2000/svg"
                  fill="none"
                  viewBox="0 0 24 24"
                >
                  <circle
                    className="opacity-25"
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    strokeWidth="4"
                  ></circle>
                  <path
                    className="opacity-75"
                    fill="currentColor"
                    d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                  ></path>
                </svg>
                {t('mcpb.uploading')}
              </>
            ) : (
              t('mcpb.upload')
            )}
          </button>
        </div>
      </div>
    </div>
  );
};

export default McpbUploadForm;

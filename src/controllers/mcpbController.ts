import { randomUUID } from 'node:crypto';
import { mcpbServerDirectoryName, mcpbServerRelativePath } from '../utils/mcpbPaths.js';
import { getServerDao } from '../dao/DaoFactory.js';
import { serverKey } from '../utils/catalog.js';
import { Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import AdmZip from 'adm-zip';
import { ApiResponse } from '../types/index.js';
import { logger } from '../utils/logger.js';
import { requireAdmin } from '../utils/requireAdmin.js';
import { validateServerName } from '../utils/serverNameValidation.js';

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    const uploadDir = path.join(process.cwd(), 'data/uploads/mcpb');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (_req, file, cb) => {
    const timestamp = Date.now();
    // Sanitize the original name so the stored path cannot escape the upload directory
    const safeOriginalName = path
      .parse(path.basename(file.originalname))
      .name.replace(/[^A-Za-z0-9._-]/g, '_');
    cb(null, `${safeOriginalName}-${timestamp}.mcpb`);
  },
});

const upload = multer({
  storage,
  fileFilter: (_req, file, cb) => {
    if (file.originalname.endsWith('.mcpb')) {
      cb(null, true);
    } else {
      cb(new Error('Only .mcpb files are allowed'));
    }
  },
  limits: {
    fileSize: 500 * 1024 * 1024, // 500MB limit
  },
});

export const uploadMiddleware = upload.single('mcpbFile');

const MCPB_UPLOAD_DIR = path.join('data', 'uploads', 'mcpb');

const getMcpbUploadDir = (): string => path.join(process.cwd(), MCPB_UPLOAD_DIR);

const validateMcpbServerName = (serverName: unknown): string => {
  // Reuse the shared server-name rule (charset + `..`/path-separator safety)
  // while keeping the MCPB-specific error wording.
  const validation = validateServerName(serverName);
  if (!validation.valid) {
    throw new Error('Invalid manifest: name contains unsafe characters');
  }

  return validation.normalized as string;
};

const resolveMcpbServerExtractDir = (baseDir: string, serverName: string): string => {
  const resolvedBaseDir = path.resolve(baseDir);
  const resolvedTargetDir = path.resolve(resolvedBaseDir, mcpbServerRelativePath(serverName));
  const relativeTargetPath = path.relative(resolvedBaseDir, resolvedTargetDir);

  if (relativeTargetPath.startsWith('..') || path.isAbsolute(relativeTargetPath)) {
    throw new Error('Invalid manifest: name resolves outside upload directory');
  }

  return resolvedTargetDir;
};

// Clean up old MCPB server files when installing a new version
const cleanupOldMcpbServer = (serverName: string): void => {
  try {
    const uploadDir = getMcpbUploadDir();
    const directories = [mcpbServerRelativePath(serverName), mcpbServerDirectoryName(serverName)];
    for (const directory of directories) {
      const installed = path.join(uploadDir, directory);
      if (fs.existsSync(installed)) fs.rmSync(installed, { recursive: true, force: true });
    }
  } catch (error) {
    logger.warn('Failed to cleanup old MCPB server files:', error);
    // Don't fail the installation if cleanup fails
  }
};

export const uploadMcpbFile = async (req: Request, res: Response): Promise<void> => {
  try {
    // Defense in depth: the route already gates this endpoint behind
    // requireAdminMiddleware (before multer stages the body). Re-check here so
    // the handler stays safe even if it is invoked through another path, since
    // it replaces executable code at a deterministic path that existing stdio
    // server configurations point into (GHSA-xf2m-3c3x-53vp).
    if (!(await requireAdmin(req, res))) return;

    if (!req.file) {
      res.status(400).json({
        success: false,
        message: 'No MCPB file uploaded',
      });
      return;
    }

    const mcpbFilePath = req.file?.path;
    const uploadRoot = `${path.resolve(getMcpbUploadDir())}${path.sep}`;
    if (!mcpbFilePath || !path.resolve(mcpbFilePath).startsWith(uploadRoot)) {
      res.status(400).json({
        success: false,
        message: mcpbFilePath ? 'Invalid MCPB file location' : 'No MCPB file uploaded',
      });
      return;
    }
    const timestamp = Date.now();
    const tempExtractDir = path.join(path.dirname(mcpbFilePath), `temp-extracted-${timestamp}`);

    try {
      const zip = new AdmZip(mcpbFilePath);
      const manifestEntry = zip.getEntry('manifest.json');
      if (!manifestEntry) throw new Error('manifest.json not found in MCPB file');
      const manifest = JSON.parse(zip.readAsText(manifestEntry));

      // Validate required fields in manifest
      if (!manifest.manifest_version) {
        throw new Error('Invalid manifest: missing manifest_version');
      }
      if (!manifest.name) {
        throw new Error('Invalid manifest: missing name');
      }
      if (!manifest.version) {
        throw new Error('Invalid manifest: missing version');
      }
      if (!manifest.server) {
        throw new Error('Invalid manifest: missing server configuration');
      }

      const safeServerName = serverKey(validateMcpbServerName(manifest.name), req.body?.catalog);

      // Use server name as the final extract directory for automatic version management
      const finalExtractDir = resolveMcpbServerExtractDir(
        path.dirname(mcpbFilePath),
        safeServerName,
      );

      if (req.body?.inspectOnly === 'true' || req.body?.skipExisting === 'true') {
        const registered = await getServerDao().exists(safeServerName);
        const legacyDir = path.join(
          path.dirname(mcpbFilePath),
          `server-${encodeURIComponent(safeServerName)}`,
        );
        const exists =
          registered ||
          fs.existsSync(finalExtractDir) ||
          fs.existsSync(legacyDir) ||
          fs.existsSync(
            path.join(path.dirname(mcpbFilePath), mcpbServerDirectoryName(safeServerName)),
          );
        if (req.body?.inspectOnly === 'true') {
          fs.unlinkSync(mcpbFilePath);
          res.json({ success: true, data: { manifest, exists, registered } });
          return;
        }
        if (exists) {
          fs.unlinkSync(mcpbFilePath);
          res.status(409).json({
            success: false,
            message: `MCP '${safeServerName}' now exists; inspect again and choose overwrite or skip`,
          });
          return;
        }
      }

      // Inspection never extracts or replaces executable files.
      zip.extractAllTo(tempExtractDir, true);

      fs.writeFileSync(path.join(tempExtractDir, '.mcphub-install-id'), randomUUID());

      // Clean up any existing version of this server
      cleanupOldMcpbServer(safeServerName);
      if (!fs.existsSync(finalExtractDir)) {
        fs.mkdirSync(finalExtractDir, { recursive: true });
      }

      // Move the temporary directory to the final location
      fs.mkdirSync(path.dirname(finalExtractDir), { recursive: true });
      fs.renameSync(tempExtractDir, finalExtractDir);
      logger.log(`MCPB server extracted to: ${finalExtractDir}`);

      // Clean up the uploaded MCPB file
      fs.unlinkSync(mcpbFilePath);

      const response: ApiResponse = {
        success: true,
        data: {
          manifest,
          extractDir: finalExtractDir,
        },
      };

      res.json(response);
    } catch (extractError) {
      // Clean up files on error
      if (fs.existsSync(mcpbFilePath)) {
        fs.unlinkSync(mcpbFilePath);
      }
      if (fs.existsSync(tempExtractDir)) {
        fs.rmSync(tempExtractDir, { recursive: true, force: true });
      }
      throw extractError;
    }
  } catch (error) {
    logger.error('MCPB upload error:', error);

    let message = 'Failed to process MCPB file';
    if (error instanceof Error) {
      message = error.message;
    }

    res.status(500).json({
      success: false,
      message,
    });
  }
};

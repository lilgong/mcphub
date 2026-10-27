import { spawnSync } from 'node:child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import AdmZip from 'adm-zip';
import { Request, Response } from 'express';
import { uploadMcpbFile } from '../../src/controllers/mcpbController.js';

const mockServerExists = jest.fn();
jest.mock('../../src/dao/DaoFactory.js', () => ({
  getServerDao: () => ({ exists: mockServerExists }),
}));

describe('mcpbController - uploadMcpbFile', () => {
  let tempRoot: string;
  let cwdSpy: jest.SpiedFunction<typeof process.cwd>;

  const createResponse = () => {
    const json = jest.fn();
    const status = jest.fn().mockReturnThis();

    return {
      json,
      status,
      response: {
        json,
        status,
      } as unknown as Response,
    };
  };

  const createMcpbFile = (manifestName: string): string => {
    const uploadDir = path.join(tempRoot, 'data/uploads/mcpb');
    const mcpbFilePath = path.join(uploadDir, 'payload.mcpb');
    const zip = new AdmZip();

    zip.addFile(
      'manifest.json',
      Buffer.from(
        JSON.stringify({
          manifest_version: '1',
          name: manifestName,
          version: '1.0.0',
          server: {
            entry: 'server.js',
          },
        }),
        'utf-8',
      ),
    );
    zip.addFile('server.js', Buffer.from('export default {};', 'utf-8'));
    zip.writeZip(mcpbFilePath);

    return mcpbFilePath;
  };

  const createAdminRequest = (mcpbFilePath: string): Request =>
    ({
      file: { path: mcpbFilePath },
      user: { username: 'admin', isAdmin: true },
    }) as Request;

  const createNonAdminRequest = (mcpbFilePath: string): Request =>
    ({
      file: { path: mcpbFilePath },
      user: { username: 'alice', isAdmin: false },
    }) as Request;

  beforeEach(() => {
    mockServerExists.mockResolvedValue(false);
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpb-controller-'));
    cwdSpy = jest.spyOn(process, 'cwd').mockReturnValue(tempRoot);
    fs.mkdirSync(path.join(tempRoot, 'data/uploads/mcpb'), { recursive: true });
  });

  afterEach(() => {
    cwdSpy.mockRestore();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('replaces only the exact server directory and preserves servers sharing its prefix', async () => {
    const uploadDir = path.join(tempRoot, 'data/uploads/mcpb');
    for (const name of ['weather', 'weather-data', 'weather-1']) {
      fs.mkdirSync(path.join(uploadDir, `server-${name}`));
      fs.writeFileSync(path.join(uploadDir, `server-${name}`, 'original.txt'), name);
    }
    const { response, json } = createResponse();
    await uploadMcpbFile(createAdminRequest(createMcpbFile('weather')), response);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    expect(fs.existsSync(path.join(uploadDir, 'server-weather', 'original.txt'))).toBe(false);
    expect(fs.existsSync(path.join(uploadDir, 'server-weather', 'server.js'))).toBe(true);
    for (const name of ['weather-data', 'weather-1']) {
      expect(fs.readFileSync(path.join(uploadDir, `server-${name}`, 'original.txt'), 'utf8')).toBe(
        name,
      );
    }
  });

  it('keeps same-name MCPB uploads in separate catalog directories', async () => {
    const uploadDir = path.join(tempRoot, 'data/uploads/mcpb');
    fs.mkdirSync(path.join(uploadDir, 'server-weather'), { recursive: true });
    fs.writeFileSync(path.join(uploadDir, 'server-weather', 'original.txt'), 'public');
    for (const catalog of ['atlas', 'toolathlon']) {
      const req = createAdminRequest(createMcpbFile('weather'));
      req.body = { catalog };
      const { response, json } = createResponse();
      await uploadMcpbFile(req, response);
      expect(json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
      expect(
        fs.existsSync(
          path.join(uploadDir, 'catalogs', catalog, `server-${catalog}~weather`, 'server.js'),
        ),
      ).toBe(true);
    }
    expect(fs.readFileSync(path.join(uploadDir, 'server-weather', 'original.txt'), 'utf8')).toBe(
      'public',
    );
  });

  it('skips existing bundles in batch mode without replacing executable files', async () => {
    const uploadDir = path.join(tempRoot, 'data/uploads/mcpb');
    const existing = path.join(uploadDir, 'server-atlas~weather');
    fs.mkdirSync(existing, { recursive: true });
    fs.writeFileSync(path.join(existing, 'server.js'), 'original executable');
    const uploaded = createMcpbFile('weather');
    const request = createAdminRequest(uploaded);
    request.body = { catalog: 'atlas', skipExisting: 'true' };
    const { response, status, json } = createResponse();
    await uploadMcpbFile(request, response);
    expect(status).toHaveBeenCalledWith(409);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ success: false }));
    expect(fs.readFileSync(path.join(existing, 'server.js'), 'utf8')).toBe('original executable');
    expect(fs.existsSync(uploaded)).toBe(false);
    expect(fs.readdirSync(uploadDir).some((name) => name.startsWith('temp-extracted-'))).toBe(
      false,
    );
  });

  it('inspects conflicts without extracting or changing existing executable files', async () => {
    const uploadDir = path.join(tempRoot, 'data/uploads/mcpb');
    const existing = path.join(uploadDir, 'server-atlas~weather');
    fs.mkdirSync(existing, { recursive: true });
    fs.writeFileSync(path.join(existing, 'server.js'), 'original');
    const uploaded = createMcpbFile('weather');
    const request = createAdminRequest(uploaded);
    request.body = { catalog: 'atlas', inspectOnly: 'true' };
    const { response, json } = createResponse();
    await uploadMcpbFile(request, response);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        data: expect.objectContaining({ exists: true, registered: false }),
      }),
    );
    expect(fs.readFileSync(path.join(existing, 'server.js'), 'utf8')).toBe('original');
    expect(fs.existsSync(uploaded)).toBe(false);
    expect(fs.readdirSync(uploadDir)).toEqual(['server-atlas~weather']);
  });

  it('reports a registered MCP as a conflict even without an extracted bundle', async () => {
    mockServerExists.mockResolvedValue(true);
    const uploaded = createMcpbFile('weather');
    const request = createAdminRequest(uploaded);
    request.body = { catalog: 'atlas', inspectOnly: 'true' };
    const { response, json } = createResponse();
    await uploadMcpbFile(request, response);
    expect(mockServerExists).toHaveBeenCalledWith('atlas::weather');
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ exists: true, registered: true }),
      }),
    );
    expect(fs.readdirSync(path.join(tempRoot, 'data/uploads/mcpb'))).toEqual([]);
  });

  it('blocks a new registration collision discovered after inspection', async () => {
    mockServerExists.mockResolvedValue(true);
    const uploaded = createMcpbFile('weather');
    const request = createAdminRequest(uploaded);
    request.body = { skipExisting: 'true' };
    const { response, status } = createResponse();
    await uploadMcpbFile(request, response);
    expect(status).toHaveBeenCalledWith(409);
    expect(fs.readdirSync(path.join(tempRoot, 'data/uploads/mcpb'))).toEqual([]);
  });

  it('supports package launchers that dynamically import absolute filesystem paths', async () => {
    const uploaded = createMcpbFile('weather');
    const zip = new AdmZip(uploaded);
    zip.addFile(
      'entry.mjs',
      Buffer.from(`import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
await import(join(dirname(fileURLToPath(import.meta.url)), 'implementation.mjs'));`),
    );
    zip.addFile('implementation.mjs', Buffer.from('console.log("weather-module-loaded");'));
    zip.writeZip(uploaded);
    const request = createAdminRequest(uploaded);
    request.body = { catalog: 'atlas' };
    const { response, json } = createResponse();
    await uploadMcpbFile(request, response);
    const extractDir = json.mock.calls[0][0].data.extractDir;
    expect(path.basename(extractDir)).toBe('server-atlas~weather');
    const child = spawnSync(process.execPath, [path.join(extractDir, 'entry.mjs')], {
      encoding: 'utf8',
      timeout: 10000,
    });
    expect(child.status).toBe(0);
    expect(child.stdout).toContain('weather-module-loaded');
  });

  it('still detects legacy percent-encoded directories during inspection', async () => {
    const uploadDir = path.join(tempRoot, 'data/uploads/mcpb');
    fs.mkdirSync(path.join(uploadDir, 'server-atlas%3A%3Aweather'), { recursive: true });
    const request = createAdminRequest(createMcpbFile('weather'));
    request.body = { catalog: 'atlas', inspectOnly: 'true' };
    const { response, json } = createResponse();
    await uploadMcpbFile(request, response);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ exists: true }) }),
    );
    expect(fs.existsSync(path.join(uploadDir, 'server-atlas%3A%3Aweather'))).toBe(true);
  });

  it('rejects manifest names that attempt path traversal', async () => {
    const mcpbFilePath = createMcpbFile('../../../escaped/server');
    const { response, json, status } = createResponse();
    const request = createAdminRequest(mcpbFilePath);
    const uploadDir = path.join(tempRoot, 'data/uploads/mcpb');
    const escapedDir = path.resolve(uploadDir, 'server-../../../escaped/server');

    await uploadMcpbFile(request, response);

    expect(status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        message: expect.stringContaining('Invalid manifest: name'),
      }),
    );
    expect(fs.existsSync(escapedDir)).toBe(false);
    expect(fs.existsSync(mcpbFilePath)).toBe(false);
    expect(
      fs.readdirSync(uploadDir).filter((file) => file.startsWith('temp-extracted-')),
    ).toHaveLength(0);
  });

  it('extracts MCPB files into the upload directory when the manifest name is safe', async () => {
    const mcpbFilePath = createMcpbFile('weather-server');
    const { response, json, status } = createResponse();
    const request = createAdminRequest(mcpbFilePath);
    const uploadDir = path.join(tempRoot, 'data/uploads/mcpb');
    const finalExtractDir = path.join(uploadDir, 'server-weather-server');

    await uploadMcpbFile(request, response);

    expect(status).not.toHaveBeenCalled();
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        data: expect.objectContaining({
          manifest: expect.objectContaining({
            name: 'weather-server',
          }),
          extractDir: finalExtractDir,
        }),
      }),
    );
    expect(fs.existsSync(path.join(finalExtractDir, 'manifest.json'))).toBe(true);
    expect(fs.existsSync(path.join(finalExtractDir, 'server.js'))).toBe(true);
  });

  it('rejects uploads from non-admin users without extracting anything', async () => {
    const mcpbFilePath = createMcpbFile('weather-server');
    const { response, json, status } = createResponse();
    const request = createNonAdminRequest(mcpbFilePath);
    const uploadDir = path.join(tempRoot, 'data/uploads/mcpb');
    const finalExtractDir = path.join(uploadDir, 'server-weather-server');

    await uploadMcpbFile(request, response);

    expect(status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        message: 'Admin privileges required',
      }),
    );
    // The handler must not delete or replace any existing bundle content.
    expect(fs.existsSync(finalExtractDir)).toBe(false);
    expect(
      fs.readdirSync(uploadDir).filter((file) => file.startsWith('temp-extracted-')),
    ).toHaveLength(0);
  });

  it('rejects uploads when no authenticated identity is present', async () => {
    const mcpbFilePath = createMcpbFile('weather-server');
    const { response, json, status } = createResponse();
    const request = { file: { path: mcpbFilePath } } as Request;

    await uploadMcpbFile(request, response);

    expect(status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        message: 'Admin privileges required',
      }),
    );
  });
});

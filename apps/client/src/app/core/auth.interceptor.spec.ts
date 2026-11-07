import { TestBed } from '@angular/core/testing';
import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { firstValueFrom } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiRefusalService } from './api-refusal.service';
import { ApiService } from './api.service';
import { authInterceptor } from './auth.interceptor';

describe('authInterceptor', () => {
  const api = { accessToken: 'token-1', getBaseUrl: () => 'http://backend.test' };
  const refusals = { handleApiResponse: vi.fn() };
  let http: HttpClient;
  let controller: HttpTestingController;

  beforeEach(() => {
    api.accessToken = 'token-1';
    refusals.handleApiResponse.mockReset();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptors([authInterceptor])),
        provideHttpClientTesting(),
        { provide: ApiService, useValue: api },
        { provide: ApiRefusalService, useValue: refusals },
      ],
    });
    http = TestBed.inject(HttpClient);
    controller = TestBed.inject(HttpTestingController);
  });

  afterEach(() => controller.verify());

  /** Sends a GET to `url`, lets `beforeAnswer` run, then answers with `status`. */
  async function answer(
    url: string,
    status: number,
    beforeAnswer = () => {},
    body: object | null = null
  ): Promise<string | null> {
    const response = firstValueFrom(http.get(url)).catch(() => undefined);
    const request = controller.expectOne(url);
    beforeAnswer();
    request.flush(body, { status, statusText: 'Refused' });
    await response;
    return request.request.headers.get('Authorization');
  }

  it('sends the token and reports refusals of the management API', async () => {
    const authorization = await answer('http://backend.test/api/registrar/config', 401);

    expect(authorization).toBe('Bearer token-1');
    expect(refusals.handleApiResponse).toHaveBeenCalledWith(401, 'token-1', null);
  });

  it('passes the body of a refusal on, which says why', async () => {
    const reason = { statusCode: 403, message: 'Forbidden resource' };
    await answer('http://backend.test/api/registrar/config', 403, undefined, reason);

    expect(refusals.handleApiResponse).toHaveBeenCalledWith(403, 'token-1', reason);
  });

  it('reports the token the request was sent with, not one renewed meanwhile', async () => {
    await answer('http://backend.test/api/registrar/config', 401, () => {
      api.accessToken = 'token-2';
    });

    expect(refusals.handleApiResponse).toHaveBeenCalledWith(401, 'token-1', null);
  });

  it('does not report answers of other addresses', async () => {
    await answer('http://backend.test/.well-known/oauth-authorization-server', 401);
    await answer('https://elsewhere.test/api/x', 403);

    expect(refusals.handleApiResponse).not.toHaveBeenCalled();
  });

  it('sends the token only to the instance signed in to', async () => {
    expect(await answer('https://elsewhere.test/.well-known/oauth-authorization-server', 200)).toBe(
      null
    );
    expect(await answer('http://backend.test.elsewhere.test/api/x', 200)).toBe(null);
    expect(await answer('http://backend.test/.well-known/oauth-authorization-server', 200)).toBe(
      'Bearer token-1'
    );
  });

  it('sends no token while no instance is set', async () => {
    const getBaseUrl = vi.spyOn(api, 'getBaseUrl').mockReturnValue(undefined as never);
    try {
      expect(await answer('http://backend.test/api/x', 401)).toBe(null);
      expect(refusals.handleApiResponse).not.toHaveBeenCalled();
    } finally {
      getBaseUrl.mockRestore();
    }
  });

  it('sends the token to an instance kept with a trailing slash', async () => {
    const getBaseUrl = vi.spyOn(api, 'getBaseUrl').mockReturnValue('http://backend.test/');
    try {
      expect(await answer('http://backend.test/api/registrar/config', 401)).toBe('Bearer token-1');
      expect(refusals.handleApiResponse).toHaveBeenCalledWith(401, 'token-1', null);
    } finally {
      getBaseUrl.mockRestore();
    }
  });
});

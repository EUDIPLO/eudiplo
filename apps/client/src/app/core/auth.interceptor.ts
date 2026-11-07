import { inject } from '@angular/core';
import { HttpErrorResponse, HttpEvent, HttpHandlerFn, HttpRequest } from '@angular/common/http';
import { ApiRefusalService } from './api-refusal.service';
import { ApiService } from './api.service';
import { withoutTrailingSlashes } from './instance-url';
import { Observable, tap } from 'rxjs';

export function authInterceptor(
  req: HttpRequest<unknown>,
  next: HttpHandlerFn
): Observable<HttpEvent<unknown>> {
  const apiService = inject(ApiService);
  const refusals = inject(ApiRefusalService);
  // The token goes only to the instance signed in to, not to other addresses such as an
  // instance URL typed on the login page.
  const signedInTo = apiService.getBaseUrl();
  const baseUrl = signedInTo && withoutTrailingSlashes(signedInTo);
  if (!baseUrl || !req.url.startsWith(`${baseUrl}/`)) return next(req);
  // The token of this request, not the one current when its answer arrives.
  const authToken = apiService.accessToken;

  // Clone the request to add the authentication header.
  const newReq = req.clone({
    headers: req.headers.append('Authorization', `Bearer ${authToken}`),
  });
  // Calls of the management API that do not go through the SDK client.
  const managementApi = req.url.startsWith(`${baseUrl}/api/`);
  return next(newReq).pipe(
    tap({
      error: (error: unknown) => {
        if (managementApi && error instanceof HttpErrorResponse) {
          refusals.handleApiResponse(error.status, authToken, error.error);
        }
      },
    })
  );
}

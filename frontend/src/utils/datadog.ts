import { datadogLogs } from '@datadog/browser-logs'
import { datadogRum } from '@datadog/browser-rum'
import {
  DATADOG_APPLICATION_ID,
  DATADOG_CLIENT_TOKEN,
  DATADOG_SITE,
  DATADOG_SERVICE,
  DATADOG_ENV,
  DATADOG_LOGS_CLIENT_TOKEN,
} from '@/config/env.config'

export function init() {
  // Only initialize on client-side
  if (typeof window === 'undefined') {
    return
  }

  if (process.env.NODE_ENV === 'development') {
    return
  }

  datadogRum.init({
    applicationId: DATADOG_APPLICATION_ID,
    clientToken: DATADOG_CLIENT_TOKEN,
    site: DATADOG_SITE,
    service: DATADOG_SERVICE,
    env: DATADOG_ENV,
    sessionSampleRate: 100,
    premiumSampleRate: 100,
    trackUserInteractions: true,
    defaultPrivacyLevel: 'mask-user-input',
  })

  datadogLogs.init({
    clientToken: DATADOG_LOGS_CLIENT_TOKEN,
    site: DATADOG_SITE,
    service: DATADOG_SERVICE,
    env: DATADOG_ENV,
    forwardErrorsToLogs: true,
    forwardConsoleLogs: ['error'],
    sessionSampleRate: 100,
  })

  datadogRum.startSessionReplayRecording()
}

export function logInfo(message: string, messageContext?: object | undefined, error?: Error | undefined) {
  // Only log on client-side
  if (typeof window === 'undefined') {
    console.log('logInfo (server):', message, messageContext)
    return
  }

  datadogLogs.logger.info(
    message,
    {
      ...messageContext,
      src: 'aztec-bridge',
    },
    error,
  )
}

export function logError(message: string, messageContext?: object | undefined, error?: Error | undefined) {
  // Only log on client-side
  if (typeof window === 'undefined') {
    console.error('logError (server):', message, messageContext, error)
    return
  }

  datadogLogs.logger.error(
    message,
    {
      ...messageContext,
      src: 'aztec-bridge',
    },
    error as Error,
  )
}

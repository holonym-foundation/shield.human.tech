import {
  Slide,
  toast,
  ToastOptions,
} from 'react-toastify'
import React from 'react'
import {
  UseQueryOptions,
  UseMutationOptions,
  useQuery,
  useMutation,
  QueryFunction,
} from '@tanstack/react-query'
import PrivacyModeToast from '@/components/toast/PrivacyModeToast'
import DefaultToast from '@/components/toast/DFToast'
import InfoToast from '@/components/toast/InfoToast'
import LoadingToast from '@/components/toast/LoadingToast'
import SuccessToast from '@/components/toast/SuccessToast'
import WarningToast from '@/components/toast/WarningToast'
import ErrorToast from '@/components/toast/ErrorToast'

/**
 * Toast System with Loading Spinner Support and Duplicate Error Prevention
 * 
 * Features:
 * - Prevents duplicate error messages from being shown simultaneously
 * - Automatic cleanup of error message tracking when toasts are dismissed
 * - Loading spinner support for async operations
 * 
 * @example Basic Usage
 * const notify = useToast()
 * notify('success', 'Operation completed!')
 * notify('error', { message: 'Failed!', heading: 'Error' })
 * 
 * @example Promise Toasts
 * notify.promise(somePromise, {
 *   pending: 'Loading...',
 *   success: 'Done!',
 *   error: 'Failed!'
 * }, { animatePromise: true })
 * 
 * @example React Query
 * useToastQuery({ queryFn, toastMessages: { pending: '...', success: '...', error: '...' } })
 * useToastMutation({ mutationFn, toastMessages: { pending: '...', success: '...', error: '...' } })
 * 
 * @example Clear Error Messages
 * notify.clearErrorMessages() // Clears the duplicate error tracking
 */

// ============================================================================
// TYPES
// ============================================================================

type ToastType = 'default' | 'success' | 'info' | 'warn' | 'error' | 'privacy-mode'

type ToastMessageInput = string | { message: string; heading?: string }

type CustomToastOptions = ToastOptions & {
  animatePromise?: boolean
}

type ToastMessageObject = {
  message: string
  heading?: string
  options?: ToastOptions
}

type ToastMessages = {
  pending?: string | ToastMessageObject
  success?: string | ToastMessageObject
  error?: string | ToastMessageObject
}

// ============================================================================
// CONSTANTS
// ============================================================================

const DEFAULT_TOAST_OPTIONS: ToastOptions = {
  position: 'top-right',
  autoClose: 5000,
  pauseOnHover: true,
  pauseOnFocusLoss: true,
  closeButton: false,
  closeOnClick: true,
  icon: false,
  transition: Slide,
}

const LOADING_TOAST_OPTIONS: Partial<ToastOptions> = {
  closeButton: false,
  closeOnClick: false,
  autoClose: false,
}

// Track active error messages to prevent duplicates
const activeErrorMessages = new Set<string>()

// ============================================================================
// TOAST COMPONENT MAPPING
// ============================================================================

const TOAST_COMPONENTS = {
  default: DefaultToast,
  success: SuccessToast,
  info: InfoToast,
  warn: WarningToast,
  error: ErrorToast,
  'privacy-mode': PrivacyModeToast,
} as const

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Normalizes message input to object format
 */
const normalizeMessage = (input: string | { message: string; heading?: string }) =>
  typeof input === 'string' ? { message: input } : input

/**
 * Extracts options from toast message object
 */
const extractOptions = (messageObj: string | ToastMessageObject) =>
  typeof messageObj === 'object' ? messageObj.options || {} : {}

/**
 * Extracts a human-readable error message from axios errors or generic errors
 */
const extractErrorMessage = (error: unknown): string | null => {
  if (!error || typeof error !== 'object') return null
  const err = error as any
  // Axios error with response body
  const responseData = err?.response?.data
  if (responseData) {
    if (typeof responseData === 'string') return responseData
    if (responseData.error) return responseData.error
    if (responseData.message) return responseData.message
  }
  // BridgeApiError
  if (err?.body) return err.body
  // Standard Error
  if (err?.message) return err.message
  return null
}

/**
 * Creates merged options with proper precedence
 */
const createMergedOptions = (baseOptions: ToastOptions, customOptions: ToastOptions = {}) => ({
  ...DEFAULT_TOAST_OPTIONS,
  ...baseOptions,
  ...customOptions,
})

/**
 * Creates a toast with the specified component and options
 */
const createToast = (
  type: ToastType,
  message: string,
  heading?: string,
  options: ToastOptions = {}
) => {
  // For error toasts, check if this exact message is already active
  if (type === 'error') {
    const messageKey = `${message}${heading ? `|${heading}` : ''}`
    
    if (activeErrorMessages.has(messageKey)) {
      // Message already exists, don't show duplicate
      return null
    }
    
    // Add to active messages
    activeErrorMessages.add(messageKey)
    
    // Set up cleanup when toast is dismissed
    const originalOnClose = options.onClose
    options.onClose = () => {
      activeErrorMessages.delete(messageKey)
      originalOnClose?.()
    }
  }

  const Component = TOAST_COMPONENTS[type]
  const errorOverrides = type === 'error' ? { autoClose: false as const, closeOnClick: false } : {}
  const toastOptions = createMergedOptions({}, { ...errorOverrides, ...options })
  const finalOptions = {
    className: `${type}-toast`,
    ...(type === 'privacy-mode' ? { toastId: 'privacy-mode-toastId' } : {}),
    ...toastOptions,
  }

  // If a toastId is specified and that toast is already active, update it in-place
  // so the message refreshes without creating a new toast or being silently ignored.
  if (finalOptions.toastId && toast.isActive(finalOptions.toastId)) {
    toast.update(finalOptions.toastId, {
      render: React.createElement(Component, { heading, message }),
      ...finalOptions,
    })
    return finalOptions.toastId
  }

  return toast(
    React.createElement(Component, { heading, message }),
    finalOptions,
  )
}

/**
 * Creates a loading toast
 */
const createLoadingToast = (message: string, heading?: string, options: ToastOptions = {}) => {
  const mergedOptions = createMergedOptions({}, options)
  
  return toast(
    React.createElement(LoadingToast, { heading, message }),
    {
      ...mergedOptions,
      className: 'loading-toast',
      ...LOADING_TOAST_OPTIONS,
    }
  )
}

/**
 * Updates a toast to success or error state
 */
const updateToastState = (
  toastId: string | number,
  type: 'success' | 'error',
  message: string,
  heading?: string,
  options: ToastOptions = {}
) => {
  // For error toasts, check if this exact message is already active
  if (type === 'error') {
    const messageKey = `${message}${heading ? `|${heading}` : ''}`
    
    if (activeErrorMessages.has(messageKey)) {
      // Message already exists, dismiss the loading toast instead of updating to error
      toast.dismiss(toastId)
      return
    }
    
    // Add to active messages
    activeErrorMessages.add(messageKey)
    
    // Set up cleanup when toast is dismissed
    const originalOnClose = options.onClose
    options.onClose = () => {
      activeErrorMessages.delete(messageKey)
      originalOnClose?.()
    }
  }

  const Component = TOAST_COMPONENTS[type]
  const errorOverrides = type === 'error' ? { autoClose: false as const, closeOnClick: false } : {}
  const mergedOptions = createMergedOptions({}, { ...errorOverrides, ...options })

  toast.update(toastId, {
    render: React.createElement(Component, { heading, message }),
    className: `${type}-toast from-loading`,
    type,
    isLoading: false,
    ...mergedOptions,
  })
}

/**
 * Handles promise toast logic
 */
const handlePromiseToast = <T>(
  promise: Promise<T>,
  messages: {
    pending: string | { message: string; heading?: string }
    success: string | { message: string; heading?: string }
    error: string | { message: string; heading?: string }
  },
  options: CustomToastOptions = {}
): Promise<T> => {
  const { animatePromise, ...toastOptions } = options
  
  // Create loading toast
  const pendingMsg = normalizeMessage(messages.pending)
  const pendingOptions = extractOptions(messages.pending)
  const toastId = createLoadingToast(pendingMsg.message, pendingMsg.heading, pendingOptions)

  return promise
    .then((data) => {
      const successMsg = normalizeMessage(messages.success)
      const successOptions = extractOptions(messages.success)
      
      if (animatePromise) {
        toast.dismiss(toastId)
        createToast('success', successMsg.message, successMsg.heading, {
          ...toastOptions,
          ...successOptions,
          className: 'success-toast from-loading',
        })
      } else {
        updateToastState(toastId, 'success', successMsg.message, successMsg.heading, {
          ...toastOptions,
          ...successOptions,
        })
      }
      return data
    })
    .catch((error) => {
      const errorMsg = normalizeMessage(messages.error)
      const errorOptions = extractOptions(messages.error)
      
      if (animatePromise) {
        toast.dismiss(toastId)
        createToast('error', errorMsg.message, errorMsg.heading, {
          ...toastOptions,
          ...errorOptions,
          className: 'error-toast from-loading',
        })
      } else {
        updateToastState(toastId, 'error', errorMsg.message, errorMsg.heading, {
          ...toastOptions,
          ...errorOptions,
        })
      }
      throw error
    })
}

// ============================================================================
// MAIN HOOK
// ============================================================================

export const useToast = () => {
  const showToast = (
    type: ToastType,
    input: ToastMessageInput,
    options?: CustomToastOptions
  ) => {
    const { message, heading } = normalizeMessage(input)
    createToast(type, message, heading, options)
  }

  showToast.promise = handlePromiseToast
  showToast.dismiss = (toastId?: string | number) => toast.dismiss(toastId)
  showToast.dismissAll = () => toast.dismiss()
  showToast.clearErrorMessages = () => {
    activeErrorMessages.clear()
  }

  return showToast
}

// ============================================================================
// REACT QUERY HOOKS
// ============================================================================

export function useToastQuery<
  TQueryFnData = unknown,
  TError = unknown,
  TData = TQueryFnData,
  TQueryKey extends Array<unknown> = unknown[]
>(
  options: Omit<UseQueryOptions<TQueryFnData, TError, TData, TQueryKey>, 'queryFn'> & {
    queryFn: QueryFunction<TQueryFnData, TQueryKey>
    toastMessages?: ToastMessages
    silentRefresh?: boolean
  }
) {
  const notify = useToast()
  const { toastMessages, queryFn, silentRefresh = true, ...queryOptions } = options

  return useQuery({
    ...queryOptions,
    queryFn: async (context) => {
      let toastId: string | number | undefined

      try {
        const result = queryFn(context)
        const resultPromise = Promise.resolve(result)

        // Show loading toast if messages are provided
        if (toastMessages?.pending) {
          const isInitialLoad = !context.signal
          if (!silentRefresh || isInitialLoad) {
            const pendingMsg = normalizeMessage(toastMessages.pending)
            const pendingOptions = extractOptions(toastMessages.pending)
            toastId = createLoadingToast(pendingMsg.message, pendingMsg.heading, pendingOptions)
          }
        }

        const data = await resultPromise

        // Show success toast
        if (toastId && toastMessages?.success) {
          const successMsg = normalizeMessage(toastMessages.success)
          const successOptions = extractOptions(toastMessages.success)
          updateToastState(toastId, 'success', successMsg.message, successMsg.heading, successOptions)
        }

        return data
      } catch (error) {
        // Show error toast
        if (toastId && toastMessages?.error) {
          const errorMsg = normalizeMessage(toastMessages.error)
          const errorOptions = extractOptions(toastMessages.error)
          updateToastState(toastId, 'error', errorMsg.message, errorMsg.heading, errorOptions)
        } else if (toastMessages?.error && !toastId) {
          // Fallback for when there's no loading toast
          const errorMsg = normalizeMessage(toastMessages.error)
          const errorOptions = extractOptions(toastMessages.error)
          notify('error', errorMsg, errorOptions)
        }
        throw error
      }
    },
  })
}

export function useToastMutation<
  TData = unknown,
  TError = unknown,
  TVariables = void,
  TContext = unknown
>(
  options: Omit<UseMutationOptions<TData, TError, TVariables, TContext>, 'mutationFn'> & {
    mutationFn: (variables: TVariables) => Promise<TData>
    toastMessages?: ToastMessages
  }
) {
  const notify = useToast()
  const { toastMessages, mutationFn, ...mutationOptions } = options
  const toastIdRef = React.useRef<string | number | undefined>(undefined)

  return useMutation({
    ...mutationOptions,
    mutationFn: async (variables) => {
      try {
        // Show loading toast
        if (toastMessages?.pending) {
          const pendingMsg = normalizeMessage(toastMessages.pending)
          const pendingOptions = extractOptions(toastMessages.pending)
          toastIdRef.current = createLoadingToast(pendingMsg.message, pendingMsg.heading, pendingOptions)
        }

        return await mutationFn(variables)
      } catch (error) {
        // Handle error in mutationFn — include backend error message if available
        if (toastIdRef.current && toastMessages?.error) {
          const errorMsg = normalizeMessage(toastMessages.error)
          const errorOptions = extractOptions(toastMessages.error)
          const backendMessage = extractErrorMessage(error)
          const displayMessage = backendMessage
            ? `${errorMsg.message}: ${backendMessage}`
            : errorMsg.message
          updateToastState(toastIdRef.current, 'error', displayMessage, errorMsg.heading, errorOptions)
          toastIdRef.current = undefined
        }
        throw error
      }
    },
    onSuccess: (data, variables, onMutateResult, fnContext) => {
      // Handle success
      if (toastIdRef.current && toastMessages?.success) {
        const successMsg = normalizeMessage(toastMessages.success)
        const successOptions = extractOptions(toastMessages.success)
        updateToastState(toastIdRef.current, 'success', successMsg.message, successMsg.heading, successOptions)
        toastIdRef.current = undefined
      } else if (toastMessages?.success && !toastIdRef.current) {
        // Fallback
        const successMsg = normalizeMessage(toastMessages.success)
        const successOptions = extractOptions(toastMessages.success)
        notify('success', successMsg, successOptions)
      }

      mutationOptions.onSuccess?.(data, variables, onMutateResult, fnContext)
    },
    onError: (error, variables, onMutateResult, fnContext) => {
      // Handle error fallback — include backend error message if available
      if (toastMessages?.error && !toastIdRef.current) {
        const errorMsg = normalizeMessage(toastMessages.error)
        const errorOptions = extractOptions(toastMessages.error)
        const backendMessage = extractErrorMessage(error)
        const displayMessage = backendMessage
          ? `${errorMsg.message}: ${backendMessage}`
          : errorMsg.message
        notify('error', { ...errorMsg, message: displayMessage }, errorOptions)
      }

      mutationOptions.onError?.(error, variables, onMutateResult, fnContext)
    },
  })
}

// ============================================================================
// STANDALONE FUNCTIONS
// ============================================================================

export const showToast = (
  type: ToastType,
  input: ToastMessageInput,
  options?: ToastOptions
) => {
  const { message, heading } = normalizeMessage(input)
  createToast(type, message, heading, options)
}

showToast.promise = handlePromiseToast
showToast.dismiss = (toastId?: string | number) => toast.dismiss(toastId)
showToast.dismissAll = () => toast.dismiss()
showToast.clearErrorMessages = () => {
  activeErrorMessages.clear()
}

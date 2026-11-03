'use client'

import { useRouter } from 'next/navigation'
import { ImageUploadControl, type ImageUploadControlProps } from '@/features/uploads/components/image-upload-control'

/** Refresh shared avatar/project readers only after the server confirms a commit. */
export function ManagedImageControl(props: Omit<ImageUploadControlProps, 'onUploaded'>) {
  const router = useRouter()
  return <ImageUploadControl {...props} onUploaded={() => router.refresh()} />
}

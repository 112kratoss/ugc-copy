'use client';

import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowRight, AtSign, BadgeCheck, CheckCircle2, ExternalLink, Loader2, Save, UserRound, Camera, ImagePlus, Globe2, MapPin, Minus, Plus, RotateCcw } from 'lucide-react';

import {
  getCreatorProfileReadiness,
  getSafeProfileNextPath,
  isGeneratedProfileUsername,
  type EditableCreatorProfile,
  type ProfileFieldErrors,
  type ProfileUpdatePayload,
} from '@/lib/profile';
import {
  PROFILE_ONBOARDING_SKIPPED_METADATA_KEY,
  PROFILE_ONBOARDING_SKIPPED_VERSION,
} from '@/lib/auth-onboarding';
import { uploadProfileMediaWithSignedIntent } from '@/lib/profile-media-upload';
import { supabase } from '@/lib/supabase';

interface CreatorProfileCardProps {
  initialProfile: EditableCreatorProfile | null;
  isLoading: boolean;
  loadError: string | null;
  onProfileSaved?: (profile: EditableCreatorProfile) => void;
  isEmbedded?: boolean;
  onboardingMode?: boolean;
  nextPath?: string;
  returnAfterSave?: boolean;
}

const EMPTY_ERRORS: ProfileFieldErrors = {};
const MAX_PROFILE_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_BIO_LENGTH = 280;
const AVATAR_CROP_SIZE = 512;
const COVER_CROP_WIDTH = 1600;
const COVER_CROP_HEIGHT = 360;
const MIN_AVATAR_ZOOM = 1;
const MAX_AVATAR_ZOOM = 3;
const DEFAULT_AVATAR_CROP = {
  x: 50,
  y: 28,
  zoom: 1.35,
};
const DEFAULT_COVER_CROP = {
  x: 50,
  y: 50,
  zoom: 1,
};

type MediaCrop = typeof DEFAULT_AVATAR_CROP;
type MediaDragState = {
  pointerId: number;
  startX: number;
  startY: number;
  cropStartX: number;
  cropStartY: number;
  frameWidth: number;
  frameHeight: number;
};

function clampPercent(value: number) {
  return Math.min(100, Math.max(0, value));
}

function clampZoom(value: number) {
  return Math.min(MAX_AVATAR_ZOOM, Math.max(MIN_AVATAR_ZOOM, Number(value.toFixed(2))));
}

function buildProfilePayload(
  form: EditableCreatorProfile,
  overrides?: Partial<Pick<EditableCreatorProfile, 'avatarUrl' | 'coverUrl'>>
): ProfileUpdatePayload {
  return {
    username: form.username,
    displayName: form.displayName,
    bio: form.bio,
    avatarUrl: overrides?.avatarUrl ?? form.avatarUrl,
    coverUrl: overrides?.coverUrl ?? form.coverUrl,
    websiteUrl: form.websiteUrl,
    twitterHandle: form.twitterHandle,
    instagramHandle: form.instagramHandle,
    tiktokHandle: form.tiktokHandle,
    location: form.location,
  };
}

function getProfileFormFingerprint(profile: EditableCreatorProfile | null): string {
  if (!profile) {
    return '';
  }

  return JSON.stringify(buildProfilePayload(profile));
}

function getMediaObjectStyle(crop: MediaCrop): CSSProperties {
  return {
    objectPosition: `${crop.x}% ${crop.y}%`,
    transform: `scale(${crop.zoom})`,
  };
}

function CropZoomControl({
  label,
  zoom,
  onChange,
}: {
  label: string;
  zoom: number;
  onChange: (zoom: number) => void;
}) {
  const updateZoom = (nextZoom: number) => onChange(clampZoom(nextZoom));

  return (
    <div className="mt-4 flex items-center gap-3 rounded-2xl border border-[var(--ui-border-subtle)] bg-[var(--ui-surface-inset)] p-2">
      <button
        type="button"
        onClick={() => updateZoom(zoom - 0.08)}
        aria-label={`Zoom out ${label}`}
        className="ui-focus-ring inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-full border border-[var(--ui-border-default)] bg-[var(--ui-surface-2)] text-[var(--ui-text-primary)]"
      >
        <Minus className="h-4 w-4" aria-hidden />
      </button>
      <input
        type="range"
        min={MIN_AVATAR_ZOOM}
        max={MAX_AVATAR_ZOOM}
        step="0.05"
        value={zoom}
        onChange={(event) => updateZoom(Number(event.target.value))}
        aria-label={`${label} zoom`}
        className="min-w-0 flex-1 accent-[var(--ui-primary)]"
      />
      <output className="w-11 text-center text-xs font-bold text-[var(--ui-text-muted)]">
        {zoom.toFixed(1)}×
      </output>
      <button
        type="button"
        onClick={() => updateZoom(zoom + 0.08)}
        aria-label={`Zoom in ${label}`}
        className="ui-focus-ring inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-full border border-[var(--ui-border-default)] bg-[var(--ui-surface-2)] text-[var(--ui-text-primary)]"
      >
        <Plus className="h-4 w-4" aria-hidden />
      </button>
    </div>
  );
}

async function loadImage(file: File): Promise<HTMLImageElement> {
  const imageUrl = URL.createObjectURL(file);

  try {
    const image = new Image();
    image.decoding = 'async';
    image.src = imageUrl;
    await image.decode();
    return image;
  } finally {
    URL.revokeObjectURL(imageUrl);
  }
}

async function buildCroppedImageFile({
  file,
  crop,
  width,
  height,
  fileName,
}: {
  file: File;
  crop: MediaCrop;
  width: number;
  height: number;
  fileName: string;
}): Promise<File> {
  const image = await loadImage(file);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');

  if (!context) {
    return file;
  }

  const baseScale = Math.max(
    width / image.naturalWidth,
    height / image.naturalHeight
  );
  const scale = baseScale * crop.zoom;
  const drawWidth = image.naturalWidth * scale;
  const drawHeight = image.naturalHeight * scale;
  const drawX = -(drawWidth - width) * (crop.x / 100);
  const drawY = -(drawHeight - height) * (crop.y / 100);

  context.clearRect(0, 0, width, height);
  context.drawImage(image, drawX, drawY, drawWidth, drawHeight);

  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, 'image/png');
  });

  if (!blob) {
    return file;
  }

  return new File([blob], fileName, { type: 'image/png' });
}

async function buildCroppedAvatarFile(file: File, crop: MediaCrop): Promise<File> {
  return buildCroppedImageFile({
    file,
    crop,
    width: AVATAR_CROP_SIZE,
    height: AVATAR_CROP_SIZE,
    fileName: 'avatar-crop.png',
  });
}

async function buildCroppedCoverFile(file: File, crop: MediaCrop): Promise<File> {
  return buildCroppedImageFile({
    file,
    crop,
    width: COVER_CROP_WIDTH,
    height: COVER_CROP_HEIGHT,
    fileName: 'cover-crop.png',
  });
}

export default function CreatorProfileCard({
  initialProfile,
  isLoading,
  loadError,
  onProfileSaved,
  isEmbedded = false,
  onboardingMode = false,
  nextPath = '/creations',
  returnAfterSave = false,
}: CreatorProfileCardProps) {
  const router = useRouter();
  const [form, setForm] = useState<EditableCreatorProfile | null>(initialProfile);
  const [savedProfile, setSavedProfile] = useState<EditableCreatorProfile | null>(initialProfile);
  const [fieldErrors, setFieldErrors] = useState<ProfileFieldErrors>(EMPTY_ERRORS);
  const [formError, setFormError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isSkipping, setIsSkipping] = useState(false);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [coverFile, setCoverFile] = useState<File | null>(null);
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null);
  const [coverPreview, setCoverPreview] = useState<string | null>(null);
  const [avatarCrop, setAvatarCrop] = useState<MediaCrop>(DEFAULT_AVATAR_CROP);
  const [coverCrop, setCoverCrop] = useState<MediaCrop>(DEFAULT_COVER_CROP);
  const avatarDragState = useRef<MediaDragState | null>(null);
  const coverDragState = useRef<MediaDragState | null>(null);
  const avatarCropControlRef = useRef<HTMLButtonElement | null>(null);
  const coverCropControlRef = useRef<HTMLButtonElement | null>(null);
  const formRef = useRef<HTMLFormElement | null>(null);
  const optionalDetailsRef = useRef<HTMLDetailsElement | null>(null);
  const allowDirtyNavigationRef = useRef(false);

  const validateProfileImage = (file: File, field: 'avatarUrl' | 'coverUrl') => {
    if (!file.type.startsWith('image/')) {
      setFieldErrors((current) => ({
        ...current,
        [field]: 'Upload an image file.',
      }));
      return false;
    }

    if (file.size > MAX_PROFILE_IMAGE_BYTES) {
      setFieldErrors((current) => ({
        ...current,
        [field]: 'Use an image smaller than 5MB.',
      }));
      return false;
    }

    return true;
  };

  const handleAvatarChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file && validateProfileImage(file, 'avatarUrl')) {
      setAvatarFile(file);
      setAvatarCrop(DEFAULT_AVATAR_CROP);
      setAvatarPreview((current) => {
        if (current) {
          URL.revokeObjectURL(current);
        }

        return URL.createObjectURL(file);
      });
      setFieldErrors((c) => ({ ...c, avatarUrl: undefined }));
    }
  };

  const handleCoverChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file && validateProfileImage(file, 'coverUrl')) {
      setCoverFile(file);
      setCoverCrop(DEFAULT_COVER_CROP);
      setCoverPreview((current) => {
        if (current) {
          URL.revokeObjectURL(current);
        }

        return URL.createObjectURL(file);
      });
      setFieldErrors((c) => ({ ...c, coverUrl: undefined }));
    }
  };

  const handleAvatarDragStart = (event: PointerEvent<HTMLButtonElement>) => {
    if (!avatarPreview) {
      return;
    }

    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    avatarDragState.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      cropStartX: avatarCrop.x,
      cropStartY: avatarCrop.y,
      frameWidth: Math.max(1, rect.width),
      frameHeight: Math.max(1, rect.height),
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handleAvatarDragMove = (event: PointerEvent<HTMLButtonElement>) => {
    const drag = avatarDragState.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }

    const deltaX = ((event.clientX - drag.startX) / drag.frameWidth) * (100 / Math.max(1, avatarCrop.zoom));
    const deltaY = ((event.clientY - drag.startY) / drag.frameHeight) * (100 / Math.max(1, avatarCrop.zoom));
    setAvatarCrop((current) => ({
      ...current,
      x: clampPercent(drag.cropStartX - deltaX),
      y: clampPercent(drag.cropStartY - deltaY),
    }));
  };

  const handleAvatarDragEnd = (event: PointerEvent<HTMLButtonElement>) => {
    if (avatarDragState.current?.pointerId === event.pointerId) {
      avatarDragState.current = null;
    }

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const handleAvatarKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const moveStep = 2.5;
    const zoomStep = 0.08;

    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight' || event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault();
      setAvatarCrop((current) => ({
        ...current,
        x:
          event.key === 'ArrowLeft'
            ? clampPercent(current.x + moveStep)
            : event.key === 'ArrowRight'
              ? clampPercent(current.x - moveStep)
              : current.x,
        y:
          event.key === 'ArrowUp'
            ? clampPercent(current.y + moveStep)
            : event.key === 'ArrowDown'
              ? clampPercent(current.y - moveStep)
              : current.y,
      }));
      return;
    }

    if (event.key === '+' || event.key === '=' || event.key === '-') {
      event.preventDefault();
      setAvatarCrop((current) => ({
        ...current,
        zoom: clampZoom(current.zoom + (event.key === '-' ? -zoomStep : zoomStep)),
      }));
    }
  };

  const handleCoverDragStart = (event: PointerEvent<HTMLButtonElement>) => {
    if (!coverPreview) {
      return;
    }

    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    coverDragState.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      cropStartX: coverCrop.x,
      cropStartY: coverCrop.y,
      frameWidth: Math.max(1, rect.width),
      frameHeight: Math.max(1, rect.height),
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handleCoverDragMove = (event: PointerEvent<HTMLButtonElement>) => {
    const drag = coverDragState.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }

    const deltaX = ((event.clientX - drag.startX) / drag.frameWidth) * (100 / Math.max(1, coverCrop.zoom));
    const deltaY = ((event.clientY - drag.startY) / drag.frameHeight) * (100 / Math.max(1, coverCrop.zoom));
    setCoverCrop((current) => ({
      ...current,
      x: clampPercent(drag.cropStartX - deltaX),
      y: clampPercent(drag.cropStartY - deltaY),
    }));
  };

  const handleCoverDragEnd = (event: PointerEvent<HTMLButtonElement>) => {
    if (coverDragState.current?.pointerId === event.pointerId) {
      coverDragState.current = null;
    }

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const handleCoverKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!coverPreview) {
      return;
    }

    const moveStep = 2.5;
    const zoomStep = 0.08;

    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight' || event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault();
      setCoverCrop((current) => ({
        ...current,
        x:
          event.key === 'ArrowLeft'
            ? clampPercent(current.x + moveStep)
            : event.key === 'ArrowRight'
              ? clampPercent(current.x - moveStep)
              : current.x,
        y:
          event.key === 'ArrowUp'
            ? clampPercent(current.y + moveStep)
            : event.key === 'ArrowDown'
              ? clampPercent(current.y - moveStep)
              : current.y,
      }));
      return;
    }

    if (event.key === '+' || event.key === '=' || event.key === '-') {
      event.preventDefault();
      setCoverCrop((current) => ({
        ...current,
        zoom: clampZoom(current.zoom + (event.key === '-' ? -zoomStep : zoomStep)),
      }));
    }
  };

  useEffect(() => {
    // A newly loaded profile replaces the editable draft and its validation state.
    setForm(initialProfile);
    setSavedProfile(initialProfile);
    setFieldErrors(EMPTY_ERRORS);
    setFormError(null);
    setSuccessMessage(null);
  }, [initialProfile]);

  useEffect(() => {
    return () => {
      if (avatarPreview) {
        URL.revokeObjectURL(avatarPreview);
      }
    };
  }, [avatarPreview]);

  useEffect(() => {
    return () => {
      if (coverPreview) {
        URL.revokeObjectURL(coverPreview);
      }
    };
  }, [coverPreview]);

  useEffect(() => {
    const cropControl = avatarCropControlRef.current;
    if (!cropControl || !avatarPreview) {
      return;
    }

    const handleWheel = (event: globalThis.WheelEvent) => {
      event.preventDefault();
      const zoomDelta = event.deltaY > 0 ? -0.08 : 0.08;
      setAvatarCrop((current) => ({
        ...current,
        zoom: clampZoom(current.zoom + zoomDelta),
      }));
    };

    cropControl.addEventListener('wheel', handleWheel, { passive: false });
    return () => {
      cropControl.removeEventListener('wheel', handleWheel);
    };
  }, [avatarPreview]);

  useEffect(() => {
    const cropControl = coverCropControlRef.current;
    if (!cropControl || !coverPreview) {
      return;
    }

    const handleWheel = (event: globalThis.WheelEvent) => {
      event.preventDefault();
      const zoomDelta = event.deltaY > 0 ? -0.08 : 0.08;
      setCoverCrop((current) => ({
        ...current,
        zoom: clampZoom(current.zoom + zoomDelta),
      }));
    };

    cropControl.addEventListener('wheel', handleWheel, { passive: false });
    return () => {
      cropControl.removeEventListener('wheel', handleWheel);
    };
  }, [coverPreview]);

  const isDirty = Boolean(
    form
    && (
      getProfileFormFingerprint(form) !== getProfileFormFingerprint(savedProfile)
      || avatarFile
      || coverFile
    )
  );

  useEffect(() => {
    if (!isDirty) {
      allowDirtyNavigationRef.current = false;
      return;
    }

    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      if (allowDirtyNavigationRef.current) {
        return;
      }
      event.preventDefault();
      event.returnValue = '';
    };

    const handleDocumentClick = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      const anchor = target?.closest<HTMLAnchorElement>('a[href]');
      if (
        !anchor
        || anchor.target === '_blank'
        || anchor.hasAttribute('download')
        || anchor.origin !== window.location.origin
      ) {
        return;
      }

      const destination = new URL(anchor.href);
      const current = new URL(window.location.href);
      if (
        destination.pathname === current.pathname
        && destination.search === current.search
        && destination.hash === current.hash
      ) {
        return;
      }

      if (!window.confirm('Leave this page without saving your profile changes?')) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }

      allowDirtyNavigationRef.current = true;
      window.setTimeout(() => {
        allowDirtyNavigationRef.current = false;
      }, 0);
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    document.addEventListener('click', handleDocumentClick, true);
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
      document.removeEventListener('click', handleDocumentClick, true);
    };
  }, [isDirty]);

  const focusFirstInvalidField = (errors: ProfileFieldErrors) => {
    const fieldOrder: Array<keyof ProfileFieldErrors> = [
      'username',
      'displayName',
      'avatarUrl',
      'bio',
      'coverUrl',
      'websiteUrl',
      'location',
      'twitterHandle',
      'instagramHandle',
      'tiktokHandle',
    ];
    const firstField = fieldOrder.find((field) => Boolean(errors[field]));
    if (!firstField) {
      return;
    }

    if (
      onboardingMode
      && ['bio', 'coverUrl', 'websiteUrl', 'location', 'twitterHandle', 'instagramHandle', 'tiktokHandle'].includes(firstField)
    ) {
      optionalDetailsRef.current?.setAttribute('open', '');
    }

    window.setTimeout(() => {
      const target = formRef.current?.querySelector<HTMLElement>(`[name="${firstField}"]`);
      target?.focus();
    }, 0);
  };

  const resetForm = () => {
    setForm(savedProfile);
    setAvatarFile(null);
    setCoverFile(null);
    setAvatarPreview((current) => {
      if (current) URL.revokeObjectURL(current);
      return null;
    });
    setCoverPreview((current) => {
      if (current) URL.revokeObjectURL(current);
      return null;
    });
    setAvatarCrop(DEFAULT_AVATAR_CROP);
    setCoverCrop(DEFAULT_COVER_CROP);
    setFieldErrors(EMPTY_ERRORS);
    setFormError(null);
    setSuccessMessage('Unsaved changes reset.');
  };

  const continueWithoutSaving = async () => {
    if (isDirty && !window.confirm('Leave profile setup without saving these changes?')) {
      return;
    }

    setIsSkipping(true);
    try {
      const { error } = await supabase.auth.updateUser({
        data: {
          [PROFILE_ONBOARDING_SKIPPED_METADATA_KEY]: PROFILE_ONBOARDING_SKIPPED_VERSION,
        },
      });
      if (error) {
        console.warn('Could not remember skipped creator onboarding:', error.message);
      }
    } catch (error) {
      console.warn('Could not remember skipped creator onboarding:', error);
    } finally {
      router.replace(getSafeProfileNextPath(nextPath));
      router.refresh();
      setIsSkipping(false);
    }
  };

  const updateField = (key: keyof EditableCreatorProfile, value: string) => {
    setForm((current) => {
      if (!current) {
        return current;
      }

      return {
        ...current,
        [key]: value,
      };
    });

    setFieldErrors((current) => ({
      ...current,
      [key]: undefined,
    }));
    setFormError(null);
    setSuccessMessage(null);
  };

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!form || isSaving) {
      return;
    }

    const clientErrors: ProfileFieldErrors = {};
    const submissionReadiness = getCreatorProfileReadiness({
      ...form,
      avatarUrl: avatarPreview || form.avatarUrl,
      coverUrl: coverPreview || form.coverUrl,
    });
    if (!form.username.trim()) {
      clientErrors.username = 'Choose a public handle.';
    } else if (onboardingMode && isGeneratedProfileUsername(form.username)) {
      clientErrors.username = 'Replace the generated handle with one that feels like yours.';
    } else if (onboardingMode && !submissionReadiness.hasClaimedHandle) {
      clientErrors.username = 'Use 3–24 lowercase letters, numbers, or hyphens.';
    }
    if (onboardingMode && !submissionReadiness.hasDisplayName) {
      clientErrors.displayName = 'Add the name you want people to see.';
    }

    if (Object.keys(clientErrors).length > 0) {
      setFieldErrors(clientErrors);
      setFormError('Complete the highlighted essentials to continue.');
      setSuccessMessage(null);
      focusFirstInvalidField(clientErrors);
      return;
    }

    setIsSaving(true);
    setFieldErrors(EMPTY_ERRORS);
    setFormError(null);
    setSuccessMessage(null);
    const uploadedStoragePaths: string[] = [];
    let cleanupAccessToken: string | null = null;

    const cleanupUploadedMedia = async () => {
      if (uploadedStoragePaths.length === 0) {
        return;
      }

      if (!cleanupAccessToken) {
        return;
      }

      try {
        const cleanupResponse = await fetch('/api/profile/media/cleanup', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${cleanupAccessToken}`,
          },
          body: JSON.stringify({ paths: uploadedStoragePaths }),
        });

        if (!cleanupResponse.ok) {
          const cleanupData = await cleanupResponse.json().catch(() => null) as { error?: string } | null;
          throw new Error(cleanupData?.error || 'Profile media cleanup failed.');
        }
      } catch (cleanupError) {
        console.error('Failed to clean up uploaded profile media:', cleanupError);
      }
    };

    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (!session?.access_token) {
        setFormError('Please log in again to update your profile.');
        return;
      }
      cleanupAccessToken = session.access_token;

      const validationResponse = await fetch('/api/profile/validate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify(buildProfilePayload(form)),
      });
      const validationData = await validationResponse.json();
      if (!validationResponse.ok) {
        if (validationData.fieldErrors) {
          const nextErrors = validationData.fieldErrors as ProfileFieldErrors;
          setFieldErrors(nextErrors);
          focusFirstInvalidField(nextErrors);
        }

        setFormError(validationData.error || 'Failed to validate profile.');
        return;
      }

      let finalAvatarUrl = form.avatarUrl;
      let finalCoverUrl = form.coverUrl;

      if (avatarFile || coverFile) {
        setSuccessMessage('Uploading new media...');
      }

      if (avatarFile) {
        const uploadFile = await buildCroppedAvatarFile(avatarFile, avatarCrop).catch(() => avatarFile);
        const upload = await uploadProfileMediaWithSignedIntent({
          accessToken: session.access_token,
          file: uploadFile,
          role: 'avatar',
        });
        uploadedStoragePaths.push(upload.storagePath);
        finalAvatarUrl = upload.publicUrl;
      }

      if (coverFile) {
        const uploadFile = await buildCroppedCoverFile(coverFile, coverCrop).catch(() => coverFile);
        const upload = await uploadProfileMediaWithSignedIntent({
          accessToken: session.access_token,
          file: uploadFile,
          role: 'cover',
        });
        uploadedStoragePaths.push(upload.storagePath);
        finalCoverUrl = upload.publicUrl;
      }

      if (avatarFile || coverFile) {
        setSuccessMessage('Saving profile data...');
      }

      const response = await fetch('/api/profile', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify(
          buildProfilePayload(form, {
            avatarUrl: finalAvatarUrl,
            coverUrl: finalCoverUrl,
          })
        ),
      });

      const data = await response.json();
      if (!response.ok) {
        await cleanupUploadedMedia();
        if (data.fieldErrors) {
          const nextErrors = data.fieldErrors as ProfileFieldErrors;
          setFieldErrors(nextErrors);
          focusFirstInvalidField(nextErrors);
        }

        setFormError(data.error || 'Failed to update profile.');
        return;
      }

      const nextProfile: EditableCreatorProfile = {
        id: data.id,
        username: data.username ?? '',
        displayName: data.displayName ?? '',
        bio: data.bio ?? '',
        avatarUrl: data.avatarUrl ?? '',
        coverUrl: data.coverUrl ?? '',
        websiteUrl: data.websiteUrl ?? '',
        twitterHandle: data.twitterHandle ?? '',
        instagramHandle: data.instagramHandle ?? '',
        tiktokHandle: data.tiktokHandle ?? '',
        location: data.location ?? '',
        credits: data.credits ?? form.credits,
      };

      setAvatarFile(null);
      setCoverFile(null);
      setAvatarPreview((current) => {
        if (current) {
          URL.revokeObjectURL(current);
        }

        return null;
      });
      setCoverPreview((current) => {
        if (current) {
          URL.revokeObjectURL(current);
        }

        return null;
      });
      setForm(nextProfile);
      setSavedProfile(nextProfile);
      setSuccessMessage(
        onboardingMode
          ? 'Creator profile saved. Continuing…'
          : returnAfterSave
            ? 'Creator profile saved. Returning…'
            : 'Creator profile updated.'
      );
      onProfileSaved?.(nextProfile);

      if (!isEmbedded) {
        if (
          returnAfterSave
          || (onboardingMode && getCreatorProfileReadiness(nextProfile).publicPublishReady)
        ) {
          router.replace(getSafeProfileNextPath(nextPath));
          router.refresh();
        } else {
          router.replace('/profile');
          router.refresh();
        }
      }
    } catch (error) {
      await cleanupUploadedMedia();
      console.error('Failed to update profile:', error);
      setFormError('Failed to update profile.');
    } finally {
      setIsSaving(false);
    }
  };

  if (isLoading) {
    return (
      <div className="mb-8 rounded-3xl border border-[var(--ui-border-subtle)] bg-[var(--ui-surface-1)] p-6">
        <div className="h-6 w-48 animate-pulse rounded bg-white/10" />
        <div className="mt-3 h-4 w-80 animate-pulse rounded bg-white/5" />
        <div className="mt-6 grid gap-4 md:grid-cols-2">
          <div className="h-12 animate-pulse rounded-2xl bg-black/40" />
          <div className="h-12 animate-pulse rounded-2xl bg-black/40" />
          <div className="h-24 animate-pulse rounded-2xl bg-black/40 md:col-span-2" />
        </div>
      </div>
    );
  }

  if (loadError) {
    return (
      <div role="alert" className="mb-8 rounded-3xl border border-red-500/20 bg-red-500/5 p-6 text-sm text-red-200">
        <p className="font-bold">{loadError}</p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="ui-focus-ring mt-4 inline-flex min-h-12 items-center rounded-full border border-red-300/25 bg-red-400/10 px-4 font-bold text-red-100"
        >
          Retry profile
        </button>
      </div>
    );
  }

  if (!form) {
    return null;
  }

  const normalizedUsername = form.username.trim().replace(/^@+/, '').toLowerCase();
  const currentReadiness = getCreatorProfileReadiness({
    ...form,
    avatarUrl: avatarPreview || form.avatarUrl,
    coverUrl: coverPreview || form.coverUrl,
  });
  const previewHref = currentReadiness.hasClaimedHandle
    ? `/creators/${normalizedUsername}`
    : null;
  const avatarPreviewStyle = avatarPreview ? getMediaObjectStyle(avatarCrop) : undefined;
  const coverPreviewStyle = coverPreview ? getMediaObjectStyle(coverCrop) : undefined;
  const essentialTasks = [
    { label: 'Custom handle', done: currentReadiness.hasClaimedHandle },
    { label: 'Display name', done: currentReadiness.hasDisplayName },
  ];
  const completedEssentialCount = essentialTasks.filter((task) => task.done).length;

  const optionalProfileFields = (
    <div className={onboardingMode
      ? 'p-5 sm:p-6'
      : 'rounded-3xl border border-[var(--ui-border-subtle)] bg-[var(--ui-surface-1)] p-5 shadow-[var(--ui-shadow-panel)] sm:p-6'}>
      <div className="mb-6">
        <h3 className="text-lg font-semibold text-white">More about you</h3>
        <p className="mt-1 text-sm leading-6 text-zinc-400">
          Optional details add context and credibility. None of them block your first creation.
        </p>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        <label className="block md:col-span-2" htmlFor="profile-bio">
          <span className="mb-2 flex items-center justify-between gap-3 text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500">
            <span>Bio <span className="normal-case tracking-normal text-zinc-600">Optional</span></span>
            <span aria-hidden>{form.bio.length}/{MAX_BIO_LENGTH}</span>
          </span>
          <textarea
            id="profile-bio"
            name="bio"
            value={form.bio || ''}
            onChange={(event) => updateField('bio', event.target.value)}
            placeholder="What do you create, and who do you create it for?"
            rows={3}
            maxLength={MAX_BIO_LENGTH}
            className="ui-focus-ring w-full rounded-2xl border border-[var(--ui-border-default)] bg-[var(--ui-surface-inset)] px-4 py-3 text-[var(--ui-text-primary)] outline-none transition placeholder:text-[var(--ui-text-faint)] focus:border-[var(--ui-focus)]"
            aria-invalid={Boolean(fieldErrors.bio)}
            aria-describedby={fieldErrors.bio ? 'profile-bio-help profile-bio-error' : 'profile-bio-help'}
          />
          <p id="profile-bio-help" className="mt-2 text-xs leading-5 text-zinc-500">
            A short specialty statement helps visitors understand your work.
          </p>
          {fieldErrors.bio ? <p id="profile-bio-error" className="mt-2 text-xs text-red-300">{fieldErrors.bio}</p> : null}
        </label>

        <div className="space-y-4 md:col-span-2">
          <div>
            <span className="block text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500">
              Cover image <span className="normal-case tracking-normal text-zinc-600">Optional</span>
            </span>
            <p id="profile-cover-help" className="mt-2 text-xs leading-5 text-zinc-500">
              Add atmosphere to the top of your public portfolio. JPG, PNG, or WebP up to 5MB.
            </p>
          </div>
          <div className="group relative">
            <button
              type="button"
              ref={coverCropControlRef}
              aria-label={coverPreview ? 'Drag cover image to position it. Scroll to zoom.' : 'Cover banner preview'}
              className={`relative h-32 w-full shrink-0 overflow-hidden rounded-2xl border border-white/10 bg-black/50 shadow-inner transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-sky-300 sm:h-40 ${
                coverPreview ? 'touch-none cursor-grab active:cursor-grabbing' : 'cursor-default'
              }`}
              onPointerDown={handleCoverDragStart}
              onPointerMove={handleCoverDragMove}
              onPointerUp={handleCoverDragEnd}
              onPointerCancel={handleCoverDragEnd}
              onKeyDown={handleCoverKeyDown}
            >
              {(coverPreview || form.coverUrl) ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={coverPreview || form.coverUrl}
                  alt="Cover preview"
                  className="h-full w-full select-none object-cover"
                  draggable={false}
                  style={coverPreviewStyle}
                />
              ) : (
                <div className="flex h-full w-full items-center justify-center text-zinc-600">
                  <ImagePlus className="h-8 w-8" aria-hidden />
                </div>
              )}
              {coverPreview ? (
                <>
                  <div className="pointer-events-none absolute inset-0 ring-2 ring-sky-200/35 ring-inset" />
                  <div className="pointer-events-none absolute inset-x-0 top-1/2 border-t border-white/20" />
                  <div className="pointer-events-none absolute inset-y-0 left-1/2 border-l border-white/20" />
                </>
              ) : null}
            </button>
            <label className="absolute bottom-3 right-3 z-10 flex cursor-pointer items-center justify-center rounded-full has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-[var(--ui-focus)]">
              <span className="flex min-h-11 items-center gap-2 rounded-full border border-white/20 bg-black/75 px-4 text-sm font-medium text-white shadow-lg backdrop-blur-md transition-colors hover:bg-zinc-900">
                <Camera className="h-4 w-4 text-[var(--ui-primary)]" aria-hidden />
                {coverPreview || form.coverUrl ? 'Change cover' : 'Upload cover'}
              </span>
              <input
                type="file"
                id="profile-cover-upload"
                name="coverUrl"
                accept="image/*"
                onChange={handleCoverChange}
                className="sr-only"
                aria-invalid={Boolean(fieldErrors.coverUrl)}
                aria-describedby={fieldErrors.coverUrl ? 'profile-cover-help profile-cover-error' : 'profile-cover-help'}
              />
            </label>
          </div>
          {coverPreview ? (
            <div>
              <p className="text-xs leading-5 text-zinc-500">Drag to position the cover, then fine-tune the zoom.</p>
              <CropZoomControl
                label="cover"
                zoom={coverCrop.zoom}
                onChange={(zoom) => setCoverCrop((current) => ({ ...current, zoom }))}
              />
            </div>
          ) : null}
          {fieldErrors.coverUrl ? <p id="profile-cover-error" className="text-xs text-red-300">{fieldErrors.coverUrl}</p> : null}
        </div>

        <label className="block" htmlFor="profile-website">
          <span className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500">
            <Globe2 className="h-3.5 w-3.5" aria-hidden /> Website
          </span>
          <input
            id="profile-website"
            name="websiteUrl"
            type="url"
            value={form.websiteUrl || ''}
            onChange={(event) => updateField('websiteUrl', event.target.value)}
            placeholder="https://your-site.com"
            autoComplete="url"
            className="ui-focus-ring w-full rounded-2xl border border-[var(--ui-border-default)] bg-[var(--ui-surface-inset)] px-4 py-3 text-[var(--ui-text-primary)] outline-none transition placeholder:text-[var(--ui-text-faint)] focus:border-[var(--ui-focus)]"
            aria-invalid={Boolean(fieldErrors.websiteUrl)}
            aria-describedby={fieldErrors.websiteUrl ? 'profile-website-error' : undefined}
          />
          {fieldErrors.websiteUrl ? <p id="profile-website-error" className="mt-2 text-xs text-red-300">{fieldErrors.websiteUrl}</p> : null}
        </label>

        <label className="block" htmlFor="profile-location">
          <span className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500">
            <MapPin className="h-3.5 w-3.5" aria-hidden /> Location
          </span>
          <input
            id="profile-location"
            name="location"
            type="text"
            value={form.location || ''}
            onChange={(event) => updateField('location', event.target.value)}
            placeholder="City, country"
            autoComplete="address-level2"
            className="ui-focus-ring w-full rounded-2xl border border-[var(--ui-border-default)] bg-[var(--ui-surface-inset)] px-4 py-3 text-[var(--ui-text-primary)] outline-none transition placeholder:text-[var(--ui-text-faint)] focus:border-[var(--ui-focus)]"
            aria-invalid={Boolean(fieldErrors.location)}
            aria-describedby={fieldErrors.location ? 'profile-location-error' : undefined}
          />
          {fieldErrors.location ? <p id="profile-location-error" className="mt-2 text-xs text-red-300">{fieldErrors.location}</p> : null}
        </label>

        {([
          ['twitterHandle', 'X (Twitter) handle'],
          ['instagramHandle', 'Instagram handle'],
          ['tiktokHandle', 'TikTok handle'],
        ] as const).map(([field, label]) => (
          <label key={field} className={field === 'tiktokHandle' ? 'block md:col-span-2' : 'block'} htmlFor={`profile-${field}`}>
            <span className="mb-2 block text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500">{label}</span>
            <div className="relative">
              <span aria-hidden className="absolute left-4 top-3.5 text-zinc-500">@</span>
              <input
                id={`profile-${field}`}
                name={field}
                type="text"
                value={form[field] || ''}
                onChange={(event) => updateField(field, event.target.value)}
                placeholder="username"
                autoCapitalize="none"
                autoCorrect="off"
                className="ui-focus-ring w-full rounded-2xl border border-[var(--ui-border-default)] bg-[var(--ui-surface-inset)] py-3 pl-8 pr-4 text-[var(--ui-text-primary)] outline-none transition placeholder:text-[var(--ui-text-faint)] focus:border-[var(--ui-focus)]"
                aria-invalid={Boolean(fieldErrors[field])}
                aria-describedby={fieldErrors[field] ? `profile-${field}-error` : undefined}
              />
            </div>
            {fieldErrors[field] ? <p id={`profile-${field}-error`} className="mt-2 text-xs text-red-300">{fieldErrors[field]}</p> : null}
          </label>
        ))}
      </div>
    </div>
  );

  return (
    <section className="space-y-6">
      {!isEmbedded && (
        <div className="flex flex-col gap-4 rounded-3xl border border-[var(--ui-border-subtle)] bg-[var(--ui-surface-1)] p-6 shadow-[var(--ui-shadow-panel)] md:flex-row md:items-start md:justify-between">
          <div>
            <div className="flex items-center gap-3">
              <div className="rounded-2xl border border-[rgba(255,122,89,0.24)] bg-[var(--ui-primary-soft)] p-3 text-[var(--ui-primary)]">
                <UserRound className="h-5 w-5" />
              </div>
              <div>
                <h2 className="text-xl font-semibold text-white">Creator Profile</h2>
                <p className="mt-1 max-w-2xl text-sm text-zinc-400">
                  Keep the identity behind your posts, portfolio, and unlocks recognizable and trustworthy.
                </p>
              </div>
            </div>
          </div>

          {previewHref ? (
            <Link
              href={previewHref}
              target="_blank"
              rel="noreferrer"
              className="ui-focus-ring inline-flex min-h-12 items-center gap-2 rounded-full border border-[var(--ui-border-default)] bg-[var(--ui-surface-2)] px-4 text-sm font-bold text-[var(--ui-text-secondary)] transition hover:bg-[var(--ui-surface-3)] hover:text-[var(--ui-text-primary)]"
            >
              Preview profile
              <ExternalLink className="h-4 w-4" />
            </Link>
          ) : (
            <span className="inline-flex items-center gap-2 rounded-full border border-white/5 bg-black/20 px-4 py-2 text-sm text-zinc-500">
              Choose a custom handle to unlock your public profile
            </span>
          )}
        </div>
      )}

      {onboardingMode ? (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,0.95fr)_minmax(300px,0.55fr)]">
          <div className="rounded-[28px] border border-white/8 bg-zinc-950/70 p-5">
            <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.2em] text-[var(--ui-primary)]">
              <BadgeCheck className="h-4 w-4" />
              Profile essentials
            </div>
            <p className="mt-4 text-lg font-semibold text-white">
              {completedEssentialCount} of {essentialTasks.length} essentials complete
            </p>
            <div
              role="progressbar"
              aria-label="Profile essentials completed"
              aria-valuemin={0}
              aria-valuemax={essentialTasks.length}
              aria-valuenow={completedEssentialCount}
              className="mt-3 h-2 overflow-hidden rounded-full bg-white/8"
            >
              <div
                className="h-full rounded-full bg-[var(--ui-primary)] transition-[width] duration-200"
                style={{ width: `${(completedEssentialCount / essentialTasks.length) * 100}%` }}
              />
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              {essentialTasks.map((task) => (
                <span
                  key={task.label}
                  className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm ${
                    task.done
                      ? 'border-emerald-300/20 bg-emerald-500/10 text-emerald-50'
                      : 'border-white/10 bg-white/[0.03] text-zinc-300'
                  }`}
                >
                  <CheckCircle2 className={`h-3.5 w-3.5 ${task.done ? 'text-emerald-300' : 'text-zinc-500'}`} />
                  {task.label}
                </span>
              ))}
            </div>
            <p className="mt-4 text-sm leading-7 text-zinc-400">
              {currentReadiness.publicPublishReady
                ? 'Your essentials are ready. Save and continue to the creation you chose.'
                : 'Choose a custom handle and display name. You can add every other detail later.'}
            </p>
            <p className={`mt-3 flex items-center gap-2 text-sm ${currentReadiness.hasAvatar ? 'text-emerald-200' : 'text-zinc-500'}`}>
              <CheckCircle2 className="h-4 w-4" aria-hidden />
              {currentReadiness.hasAvatar ? 'Avatar added — ready to build buyer trust.' : 'Avatar recommended before selling unlocks.'}
            </p>
          </div>

          <div className="rounded-[28px] border border-white/8 bg-[linear-gradient(180deg,rgba(14,18,25,0.96),rgba(7,9,12,0.98))] p-5">
            <div className="text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500">Public preview</div>
            <div className="mt-4 overflow-hidden rounded-[22px] border border-white/8 bg-black/35">
              <div className="h-20 bg-[radial-gradient(circle_at_top_left,rgba(56,189,248,0.28),transparent_42%),linear-gradient(135deg,rgba(16,185,129,0.16),rgba(59,130,246,0.1))]">
                {(coverPreview || form.coverUrl) ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={coverPreview || form.coverUrl}
                    alt=""
                    className="h-full w-full object-cover"
                    style={coverPreviewStyle}
                  />
                ) : null}
              </div>
              <div className="px-4 pb-4">
                <div className="-mt-7 h-14 w-14 overflow-hidden rounded-full border border-white/15 bg-zinc-950">
                  {(avatarPreview || form.avatarUrl) ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={avatarPreview || form.avatarUrl}
                      alt=""
                      className="h-full w-full object-cover"
                      style={avatarPreviewStyle}
                    />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center text-zinc-500">
                      <UserRound className="h-6 w-6" />
                    </div>
                  )}
                </div>
                <div className="mt-3 text-sm font-semibold text-white">{form.displayName.trim() || 'Creator name'}</div>
                <div className="mt-1 text-xs text-zinc-500">@{normalizedUsername || 'creator-name'}</div>
                <p className="mt-3 line-clamp-2 text-xs leading-5 text-zinc-400">
                  {form.bio.trim() || 'A short creator bio will appear here.'}
                </p>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      <form ref={formRef} id="creator-profile-form" onSubmit={handleSubmit} noValidate className="space-y-6">
        <div className="rounded-3xl border border-[var(--ui-border-subtle)] bg-[var(--ui-surface-1)] p-5 shadow-[var(--ui-shadow-panel)] sm:p-6">
          <div className="mb-6 flex flex-col gap-1">
            <h3 className="text-lg font-semibold text-white">Your public identity</h3>
            <p className="text-sm text-zinc-400">Start with the two essentials. An avatar is encouraged but can be added later.</p>
          </div>

          <div className="grid gap-6 md:grid-cols-2">
            <label className="block" htmlFor="profile-username">
              <span className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500">
                <AtSign className="h-3.5 w-3.5" aria-hidden />
                Username <span className="text-[var(--ui-primary)]">Required</span>
              </span>
              <input
                id="profile-username"
                name="username"
                type="text"
                value={form.username || ''}
                onChange={(event) => updateField('username', event.target.value)}
                placeholder="creator-name"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                className="ui-focus-ring w-full rounded-2xl border border-[var(--ui-border-default)] bg-[var(--ui-surface-inset)] px-4 py-3 text-[var(--ui-text-primary)] outline-none transition focus:border-[var(--ui-focus)]"
                autoComplete="off"
                aria-invalid={Boolean(fieldErrors.username)}
                aria-describedby={fieldErrors.username ? 'profile-username-help profile-username-error' : 'profile-username-help'}
              />
              <p id="profile-username-help" className="mt-2 text-xs leading-5 text-zinc-500">
                {previewHref ? `Public URL: ${previewHref}` : 'Replace the suggestion with 3–24 lowercase letters, numbers, or hyphens.'}
              </p>
              {fieldErrors.username ? <p id="profile-username-error" className="mt-2 text-xs text-red-300">{fieldErrors.username}</p> : null}
            </label>

            <label className="block" htmlFor="profile-display-name">
              <span className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500">
                Display name <span className="text-[var(--ui-primary)]">Required</span>
              </span>
              <input
                id="profile-display-name"
                name="displayName"
                type="text"
                value={form.displayName || ''}
                onChange={(event) => updateField('displayName', event.target.value)}
                placeholder="Your creator name"
                className="ui-focus-ring w-full rounded-2xl border border-[var(--ui-border-default)] bg-[var(--ui-surface-inset)] px-4 py-3 text-[var(--ui-text-primary)] outline-none transition focus:border-[var(--ui-focus)]"
                autoComplete="name"
                aria-invalid={Boolean(fieldErrors.displayName)}
                aria-describedby={fieldErrors.displayName ? 'profile-display-name-help profile-display-name-error' : 'profile-display-name-help'}
              />
              <p id="profile-display-name-help" className="mt-2 text-xs leading-5 text-zinc-500">The name shown on posts and your portfolio.</p>
              {fieldErrors.displayName ? <p id="profile-display-name-error" className="mt-2 text-xs text-red-300">{fieldErrors.displayName}</p> : null}
            </label>

            <div className="space-y-4 border-t border-[var(--ui-border-subtle)] pt-6 md:col-span-2">
              <div>
                <span className="block text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500">
                  Avatar <span className="normal-case tracking-normal text-zinc-600">Recommended</span>
                </span>
                <p id="profile-avatar-help" className="mt-2 text-xs leading-5 text-zinc-500">
                  A recognizable portrait builds trust and is required before selling unlocks. JPG, PNG, or WebP up to 5MB.
                </p>
              </div>
              <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
                <div className="h-20 w-20 shrink-0 overflow-hidden rounded-full border border-white/10 bg-black/50 shadow-inner">
                  {(avatarPreview || form.avatarUrl) ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={avatarPreview || form.avatarUrl} alt="Avatar preview" className="h-full w-full object-cover" style={avatarPreviewStyle} />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center text-zinc-600"><UserRound className="h-8 w-8" aria-hidden /></div>
                  )}
                </div>
                <label className="group relative flex min-h-12 w-fit cursor-pointer items-center justify-center gap-2 rounded-2xl border border-[var(--ui-border-default)] bg-[var(--ui-surface-inset)] px-5 py-3 text-sm font-bold text-[var(--ui-text-primary)] transition hover:border-[rgba(255,122,89,0.4)] hover:bg-[var(--ui-surface-2)] has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-[var(--ui-focus)]">
                  <Camera className="h-4 w-4 text-[var(--ui-primary)]" aria-hidden />
                  {avatarPreview || form.avatarUrl ? 'Change avatar' : 'Add avatar'}
                  <input
                    type="file"
                    id="profile-avatar-upload"
                    name="avatarUrl"
                    accept="image/*"
                    onChange={handleAvatarChange}
                    className="sr-only"
                    aria-invalid={Boolean(fieldErrors.avatarUrl)}
                    aria-describedby={fieldErrors.avatarUrl ? 'profile-avatar-help profile-avatar-error' : 'profile-avatar-help'}
                  />
                </label>
              </div>
              {fieldErrors.avatarUrl ? <p id="profile-avatar-error" className="text-xs text-red-300">{fieldErrors.avatarUrl}</p> : null}

              {avatarPreview ? (
                <div className="rounded-[24px] border border-sky-300/15 bg-sky-500/[0.06] p-4">
                  <div className="flex flex-col gap-5 lg:flex-row lg:items-center">
                    <div className="mx-auto w-full max-w-[220px] shrink-0 lg:mx-0">
                      <button
                        type="button"
                        ref={avatarCropControlRef}
                        aria-label="Drag avatar image to position the face. Scroll to zoom."
                        className="relative mx-auto h-40 w-40 touch-none cursor-grab overflow-hidden rounded-full border border-white/15 bg-black/50 shadow-inner transition active:cursor-grabbing focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-sky-300"
                        onPointerDown={handleAvatarDragStart}
                        onPointerMove={handleAvatarDragMove}
                        onPointerUp={handleAvatarDragEnd}
                        onPointerCancel={handleAvatarDragEnd}
                        onKeyDown={handleAvatarKeyDown}
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={avatarPreview} alt="Cropped avatar preview" className="h-full w-full select-none object-cover" draggable={false} style={avatarPreviewStyle} />
                        <div className="pointer-events-none absolute inset-0 rounded-full ring-2 ring-sky-200/45 ring-inset" />
                        <div className="pointer-events-none absolute inset-x-10 top-1/2 border-t border-white/20" />
                        <div className="pointer-events-none absolute inset-y-10 left-1/2 border-l border-white/20" />
                      </button>
                      <p className="mt-3 text-center text-xs text-zinc-500">Drag to position. Scroll to zoom.</p>
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-semibold text-white">Frame your face</div>
                      <p className="mt-1 text-xs leading-5 text-zinc-400">Move and scale the image until your face sits clearly in frame.</p>
                      <CropZoomControl label="avatar" zoom={avatarCrop.zoom} onChange={(zoom) => setAvatarCrop((current) => ({ ...current, zoom }))} />
                    </div>
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        </div>

        {onboardingMode ? (
          <details ref={optionalDetailsRef} className="group rounded-3xl border border-[var(--ui-border-subtle)] bg-[var(--ui-surface-1)]">
            <summary className="ui-focus-ring flex min-h-14 cursor-pointer list-none items-center justify-between gap-4 rounded-3xl px-5 py-4 text-sm font-bold text-[var(--ui-text-primary)] marker:content-none sm:px-6">
              <span>
                Add optional details
                <span className="ml-2 font-normal text-[var(--ui-text-muted)]">Bio, cover, links, and location</span>
              </span>
              <Plus className="h-4 w-4 transition-transform group-open:rotate-45" aria-hidden />
            </summary>
            <div className="border-t border-[var(--ui-border-subtle)]">{optionalProfileFields}</div>
          </details>
        ) : optionalProfileFields}

        <div className="rounded-3xl border border-[rgba(255,122,89,0.24)] bg-[var(--ui-primary-soft)] p-6 backdrop-blur-md">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="text-sm text-zinc-400">
              {onboardingMode ? (
                'Only the handle and display name are required to continue.'
              ) : form.credits !== null ? (
                <span><strong className="text-amber-200">{form.credits} credits</strong> available right now.</span>
              ) : (
                'Credits will update automatically from your account.'
              )}
            </div>
            <div className="flex flex-col items-start gap-3 sm:items-end">
              <div aria-live="polite" aria-atomic="true">
                {formError ? <p role="alert" className="text-sm text-red-300">{formError}</p> : null}
                {!formError && successMessage ? <p role="status" className="text-sm text-emerald-300">{successMessage}</p> : null}
              </div>
              <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
                {isDirty ? (
                  <button
                    type="button"
                    onClick={resetForm}
                    disabled={isSaving || isSkipping}
                    className="ui-focus-ring inline-flex min-h-12 items-center justify-center gap-2 rounded-full px-4 text-sm font-bold text-[var(--ui-text-muted)] transition hover:bg-white/5 hover:text-white disabled:opacity-60"
                  >
                    <RotateCcw className="h-4 w-4" aria-hidden /> Reset changes
                  </button>
                ) : null}
                {onboardingMode ? (
                  <button
                    type="button"
                    onClick={() => void continueWithoutSaving()}
                    disabled={isSaving || isSkipping}
                    className="ui-focus-ring inline-flex min-h-12 items-center justify-center rounded-full border border-[var(--ui-border-default)] bg-[var(--ui-surface-2)] px-5 text-sm font-bold text-[var(--ui-text-secondary)] transition hover:bg-[var(--ui-surface-3)] hover:text-white disabled:opacity-60"
                  >
                    {isSkipping ? 'Skipping…' : 'Skip for now'}
                  </button>
                ) : null}
                <button
                  type="submit"
                  disabled={isSaving || isSkipping}
                  className="ui-focus-ring inline-flex min-h-12 items-center justify-center gap-2 rounded-full bg-[var(--ui-primary)] px-7 text-sm font-extrabold text-[var(--ui-primary-on)] transition hover:bg-[var(--ui-primary-strong)] active:scale-[0.985] disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {isSaving ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : !onboardingMode ? <Save className="h-4 w-4" aria-hidden /> : null}
                  {isSaving
                    ? 'Saving…'
                    : onboardingMode
                      ? 'Save and continue'
                      : returnAfterSave
                        ? 'Save and return'
                        : 'Save changes'}
                  {!isSaving && (onboardingMode || returnAfterSave) ? <ArrowRight className="h-4 w-4" aria-hidden /> : null}
                </button>
              </div>
            </div>
          </div>
        </div>
      </form>
    </section>
  );
}

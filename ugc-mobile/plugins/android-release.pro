# Magic Booklet release keep rules.
#
# Applied by plugins/withAndroidReleaseSafety.js on top of the AGP default
# (proguard-android-optimize.txt) and the generated android/app/proguard-rules.pro.
# Pinned by __tests__/android-config.test.ts; narrowed one step per
# device-verified build by docs/android-app-optimization-plan-2026-09-05.md.
#
# Why this file exists: 0.1.2 (build 62) shipped with R8 on and reached testers
# unusable. expo-modules-core turns every JS options object into a Kotlin record
# through kotlin-reflect and Unsafe allocation, and that path needs the record
# class, its members, its @kotlin.Metadata and the converter runtime itself to
# survive R8. Build 62 flipped several R8 switches at once and the revert
# flipped them all back; phase 4b of the plan (2026-09-05) isolated the culprit
# on a device: shrinking expo.modules.kotlin.**. Only launching a release build
# on a device proves a shape (a green build proves nothing here).

# expo-modules-core's runtime. Every class and member stays (optimizable, never
# shrinkable). With `allowshrinking` here the release reproduced build 62
# exactly - every record class intact, yet "Cannot create a record of the type"
# and a NullPointerException under every record cast - because the converter's
# and allocators' members had been removed as unreachable. Full mode and the
# optimizer were not the cause.
-keep,allowoptimization class expo.modules.kotlin.** { *; }

# Looked up by name: Class.forName("expo.modules.ExpoModulesPackageList") in
# expo-modules-core (ExpoModulesHelper, TaskServiceProviderHelper) and in expo
# (ExpoModulesPackage); ModulePriorities keys expo-updates' package by name.
-keep,allowoptimization class expo.modules.ExpoModulesPackageList { *; }
-keepnames class expo.modules.updates.UpdatesPackage

# The modules themselves (expo.modules.<module>.**) carry no blanket rule since
# phase 4c. expo-modules-core's consumer rules keep their records and
# enumerables with members, Module and ExpoView constructors, view-event
# members, ComposeProps and Services; everything else may be shrunk, renamed
# and optimized.

# kotlin-reflect reads @kotlin.Metadata plus runtime annotations and generic
# signatures. kotlin-reflect.jar bundles the same rules under META-INF, but the
# app must not depend on the Gradle plugin picking those up.
-keep class kotlin.Metadata { *; }
-keepattributes InnerClasses,Signature,RuntimeVisible*Annotations,EnclosingMethod,AnnotationDefault
-dontwarn kotlin.reflect.jvm.internal.**

# The two modules that failed in build 62, named so their shape can never move
# by accident: optimizable, never shrinkable.
-keep,allowoptimization class expo.modules.securestore.** { *; }
-keep,allowoptimization class expo.modules.image.** { *; }

# expo-image-picker's crop screen reaches into the cropper library by reflection
# (ExpoCropImageActivity: getDeclaredField("cropImageOptions") and
# getDeclaredMethod("setCustomizations")); full mode keeps neither implicitly.
-keepclassmembers class com.canhub.cropper.CropImageActivity {
  *** cropImageOptions;
  *** setCustomizations();
}

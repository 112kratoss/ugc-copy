# Magic Booklet release keep rules.
#
# Applied by plugins/withAndroidReleaseSafety.js on top of the AGP default
# (proguard-android-optimize.txt) and the generated android/app/proguard-rules.pro.
# Pinned by __tests__/android-config.test.ts; narrowed one step per
# device-verified build by docs/android-app-optimization-plan-2026-09-05.md.
#
# Why this file exists: 0.1.2 (build 62) shipped with R8 on and reached testers
# unusable. expo-modules-core turns every JS options object into a Kotlin record
# through kotlin-reflect, and that path needs the record class, its members and
# its @kotlin.Metadata to survive R8 untouched. Build 62 flipped several R8
# switches at once and the revert flipped them all back, so no single rule below
# is proven necessary on its own. The set is deliberately broad; only launching
# a release build on a device proves it (a green build proves nothing here).

# expo-modules-core's runtime (expo.modules.kotlin.**) converts JS values into
# Kotlin records through kotlin-reflect and Unsafe allocation. Shrinking it is
# what broke build 62: with `allowshrinking` on this package the release
# reproduced the exact failure on 2026-09-05 (phase 4b, first attempt) - every
# record class intact, yet "Cannot create a record of the type" and a
# NullPointerException under every record cast - because the converter's own
# members and helper classes had been removed as unreachable. Full mode and
# the optimizer were not the cause. The runtime therefore keeps every class and
# member (optimizable, never shrinkable).
-keep,allowoptimization class expo.modules.kotlin.** { *; }

# Phase 4b: the modules themselves (expo.modules.<module>.**) may lose unused
# code; whatever survives keeps its name and members, and R8 may inline and
# merge inside it. Their records and enumerables, Module and ExpoView
# constructors are pinned by expo-modules-core's consumer rules regardless.
-keep,allowoptimization,allowshrinking class expo.modules.** { *; }

# kotlin-reflect reads @kotlin.Metadata plus runtime annotations and generic
# signatures. kotlin-reflect.jar bundles the same rules under META-INF, but the
# app must not depend on the Gradle plugin picking those up.
-keep class kotlin.Metadata { *; }
-keepattributes InnerClasses,Signature,RuntimeVisible*Annotations,EnclosingMethod,AnnotationDefault
-dontwarn kotlin.reflect.jvm.internal.**

# The two modules that failed in build 62, named so a future narrowing of the
# expo.modules.** rule cannot drop them by accident.
-keep class expo.modules.securestore.** { *; }
-keep class expo.modules.image.** { *; }

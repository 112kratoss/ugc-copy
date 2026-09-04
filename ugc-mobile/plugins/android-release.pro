# Magic Booklet release keep rules.
#
# Applied by plugins/withAndroidReleaseSafety.js on top of the AGP default
# (proguard-android.txt) and the generated android/app/proguard-rules.pro.
# Pinned by __tests__/android-config.test.ts.
#
# Why this file exists: 0.1.2 (build 62) shipped with R8 on and reached testers
# unusable. expo-modules-core turns every JS options object into a Kotlin record
# through kotlin-reflect, and that path needs the record class, its members and
# its @kotlin.Metadata to survive R8 untouched. Build 62 flipped several R8
# switches at once and the revert flipped them all back, so no single rule below
# is proven necessary on its own. The set is deliberately broad; only launching
# a release build on a device proves it (a green build proves nothing here).

# Every Expo module - records, enumerables, view props, module definitions -
# stays intact and unrenamed. Play's obfuscation score still clears its 25%
# threshold on React Native, AndroidX, the Kotlin stdlib, Glide and media3,
# none of which need this.
-keep class expo.modules.** { *; }

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

import { Image } from 'expo-image'
import React from 'react'
import { Text, View } from 'react-native'
import { useTheme } from '@/components/theme-provider'

/**
 * The picture next to a token amount.
 *
 * Only a token Nod recognises by its mint gets a logo (`logo` comes from the registry in
 * features/approvals/lib/tokens, never from what the token calls itself). SKR is drawn as a plain
 * badge for now: the official artwork is in the Solana Mobile press kit, which is not bundled here.
 * To use it, add the file as assets/images/skr.png and set SKR_IMAGE below.
 */
const SKR_IMAGE: any = null // e.g. require('@/assets/images/skr.png')

export function TokenLogo({ logo, size = 28 }: { logo: string | null | undefined; size?: number }) {
  const { tokens } = useTheme()
  if (logo !== 'skr') return null
  if (SKR_IMAGE) {
    return (
      <Image
        source={SKR_IMAGE}
        style={{ width: size, height: size, borderRadius: size / 2 }}
        accessibilityLabel="SKR"
      />
    )
  }
  return (
    <View
      accessibilityLabel="SKR"
      style={{
        alignItems: 'center',
        backgroundColor: tokens.accent,
        borderRadius: size / 2,
        height: size,
        justifyContent: 'center',
        width: size,
      }}
    >
      <Text style={{ color: tokens.bg, fontSize: size * 0.34, fontWeight: '800', letterSpacing: -0.3 }}>SKR</Text>
    </View>
  )
}

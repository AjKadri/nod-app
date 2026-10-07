import { NetworkFeatureIndex } from '@/features/network/network-feature-index'
import { AccountFeatureIndex } from '@/features/account/account-feature-index'
import { ApprovalsFeatureIndex } from '@/features/approvals/approvals-feature-index'
import { AppConfig } from '@/constants/app-config'
import { ScrollView, Text, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import React from 'react'
import { appStyles } from '@/constants/app-styles'

export default function HomeScreen() {
  return (
    <SafeAreaView style={appStyles.screen}>
      <ScrollView contentContainerStyle={appStyles.stack}>
        <Text style={appStyles.title}>App Config</Text>
        <View style={appStyles.card}>
          <Text>
            Name <Text style={{ fontWeight: 'bold' }}>{AppConfig.name}</Text>
          </Text>
          <Text>
            URL <Text style={{ fontWeight: 'bold' }}>{AppConfig.uri}</Text>
          </Text>
        </View>
        <AccountFeatureIndex />
        <ApprovalsFeatureIndex />
        <NetworkFeatureIndex />
      </ScrollView>
    </SafeAreaView>
  )
}

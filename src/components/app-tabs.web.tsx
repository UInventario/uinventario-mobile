import { TabList, TabSlot, Tabs, TabTrigger, TabTriggerSlotProps } from 'expo-router/ui';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Colors, MaxContentWidth, Spacing } from '@/constants/theme';

export default function AppTabs() {
  return (
    <Tabs>
      <TabSlot style={styles.slot} />
      <TabList asChild>
        <View style={styles.tabList}>
          <Text style={styles.brand}>UInventario</Text>
          <TabTrigger name="home" href="/" asChild>
            <TabButton>Inicio</TabButton>
          </TabTrigger>
          <TabTrigger name="environment" href="/explore" asChild>
            <TabButton>Entorno</TabButton>
          </TabTrigger>
          <TabTrigger name="catalog" href="/catalog" asChild>
            <TabButton>Catálogo</TabButton>
          </TabTrigger>
        </View>
      </TabList>
    </Tabs>
  );
}

function TabButton({ children, isFocused, ...props }: TabTriggerSlotProps) {
  return (
    <Pressable
      {...props}
      style={({ pressed }) => [
        styles.tabButton,
        isFocused && styles.tabButtonFocused,
        pressed && styles.pressed,
      ]}>
      <Text style={[styles.tabLabel, isFocused && styles.tabLabelFocused]}>{children}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  slot: { height: '100%' },
  tabList: {
    position: 'absolute',
    top: Spacing.three,
    alignSelf: 'center',
    width: '95%',
    maxWidth: MaxContentWidth,
    padding: Spacing.two,
    borderRadius: 18,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: Colors.light.border,
  },
  brand: { marginRight: 'auto', marginLeft: Spacing.two, fontSize: 16, fontWeight: '800' },
  tabButton: { minHeight: 44, paddingHorizontal: Spacing.three, justifyContent: 'center', borderRadius: 12 },
  tabButtonFocused: { backgroundColor: Colors.light.backgroundElement },
  tabLabel: { color: Colors.light.textSecondary, fontWeight: '600' },
  tabLabelFocused: { color: Colors.light.primary },
  pressed: { opacity: 0.65 },
});

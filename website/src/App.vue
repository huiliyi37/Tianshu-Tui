<script setup lang="ts">
import Navbar from '@/components/Navbar.vue'
import Hero from '@/components/Hero.vue'
import TrustBar from '@/components/TrustBar.vue'
import Features from '@/components/Features.vue'
import StarSkills from '@/components/StarSkills.vue'
import TerminalDemo from '@/components/TerminalDemo.vue'
import DownloadSection from '@/components/DownloadSection.vue'
import QuickStart from '@/components/QuickStart.vue'
import FAQ from '@/components/FAQ.vue'
import Community from '@/components/Community.vue'
import Footer from '@/components/Footer.vue'
import MouseGlow from '@/components/MouseGlow.vue'
</script>

<template>
  <MouseGlow />
  <main>
    <Navbar />
    <Hero />
    <TrustBar />
    <Features />
    <StarSkills />
    <TerminalDemo />
    <DownloadSection />
    <QuickStart />
    <FAQ />
    <Community />
    <Footer />
  </main>
</template>
